import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../../agents/agent-lifecycle-registry.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import {
  discardResponse,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  readGitHubJsonResponse,
} from "../control-ui-github-api.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import {
  readRepositoryWorkerProjectSnapshot,
  type RepositoryWorkerProjectSnapshot,
} from "./repository-project-source.js";

const GitObject = /^[a-f0-9]{40}$/u;
// Commit lookup requests one changed file; trees are nonrecursive and inspect
// only the root and .openclaw directory. Oversized/truncated metadata is not absence.
const METADATA_MAX_BYTES = 1024 * 1024;
type AdmissionRequest = {
  namespace: string;
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal?: AbortSignal;
  knownRecipe?: (
    project: RepositoryWorkerProjectSnapshot,
  ) => { project: RepositoryWorkerProjectSnapshot; setupRecipe?: string } | undefined;
} & (
  | {
      repository: { agentId: string; url: string; ref?: string; baseCommit?: string };
      expected?: never;
    }
  | { expected: RepositoryWorkerProjectSnapshot; repository?: never }
);

function objectSha(value: unknown): string {
  if (!isRecord(value) || typeof value.sha !== "string" || !GitObject.test(value.sha)) {
    throw new Error("GitHub returned invalid repository object metadata; retry preparation.");
  }
  return value.sha;
}

function sourceChanged(): never {
  throw new Error(
    "Prepared repository identity changed; retry with the current source and account.",
  );
}

/** Admit public source before capacity selection; verified private source keeps cold preparation. */
export async function prepareRepositoryWorkerProjectSource(params: AdmissionRequest) {
  const expected = params.expected && readRepositoryWorkerProjectSnapshot(params.expected);
  const request = expected
    ? {
        agentId: expected.source.owner.agent.agentId,
        url: expected.source.url,
        baseCommit: expected.baseCommit,
        ref: undefined,
      }
    : params.repository;
  if (!request || !/^[A-Za-z0-9_-]{1,128}$/u.test(params.namespace)) {
    throw new Error("Repository preparation request is invalid");
  }
  const url = parseProjectGitUrl(request.url)?.url;
  if (!url || (request.baseCommit !== undefined && !GitObject.test(request.baseCommit))) {
    throw new Error("Repository preparation requires a GitHub URL and a valid pinned commit");
  }
  const agent =
    expected?.source.owner.agent ??
    captureAgentLifecycleBinding(params.getConfig(), request.agentId);
  if (!agent) {
    throw new Error("Repository preparation requires an existing agent that is not being deleted");
  }
  const getConfig = params.getConfig;
  const assertAgent = () => {
    if (!matchesAgentLifecycleBinding(getConfig(), agent)) {
      sourceChanged();
    }
  };
  const assertAdmission = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    assertAgent();
  };
  const prepareIdentity = async () => {
    assertAgent();
    const config = getConfig();
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId: agent.agentId,
      getCurrentConfig: getConfig,
      assertActive: assertAgent,
      refresh: () => requestCurrentGitHubOAuthRefresh(agent.agentId),
      allowAnonymous: true,
    }).catch((error: unknown) => {
      assertAgent();
      // Native credential subprocess diagnostics must never enter provider errors.
      throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
    });
    assertAgent();
    return identity;
  };
  assertAdmission();
  let identity = await prepareIdentity();
  assertAdmission();
  const owner = { agent, identity: identity.selection };
  if (expected && !isDeepStrictEqual(owner, expected.source.owner)) {
    sourceChanged();
  }
  const assertCurrent = () => {
    assertAgent();
    identity.assertSelected();
  };
  const repositoryPath = new URL(url).pathname.replace(/\.git$/u, "");
  const endpoint = `${GITHUB_API_ORIGIN}/repos${repositoryPath}`;
  const read = async (
    suffix: string,
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    assertOwner();
    const response = await fetchGitHubApi(
      endpoint + suffix,
      fetch,
      readIdentity.token,
      async () => sourceChanged(),
      readIdentity,
      undefined,
      signal,
    );
    let value: unknown;
    try {
      assertOwner();
      value = await readGitHubJsonResponse(response, METADATA_MAX_BYTES);
    } finally {
      await discardResponse(response);
    }
    await readIdentity.revalidate();
    assertOwner();
    return value;
  };
  const readRepository = async (
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
  ) => {
    const value = await read("", readIdentity, assertOwner, signal);
    if (
      !isRecord(value) ||
      typeof value.node_id !== "string" ||
      !/^[A-Za-z0-9_+/=-]{1,256}$/u.test(value.node_id) ||
      typeof value.clone_url !== "string" ||
      parseProjectGitUrl(value.clone_url)?.url !== url ||
      typeof value.private !== "boolean" ||
      (readIdentity.selection.source === "anonymous" && value.private)
    ) {
      sourceChanged();
    }
    return {
      repositoryId: value.node_id,
      defaultBranch: value.default_branch,
      private: value.private,
    };
  };
  const metadata = await readRepository(identity, assertAdmission, params.signal);
  if (metadata.private) {
    // Only new private requests retain the supported cold repository flow. An
    // existing public preparation cannot become access to newly private contents.
    if (expected) {
      sourceChanged();
    }
    assertAdmission();
    return undefined;
  }
  const repositoryId = metadata.repositoryId;
  if (expected && repositoryId !== expected.source.repositoryId) {
    sourceChanged();
  }
  const requestedRef =
    request.ref === undefined || request.ref === "HEAD"
      ? typeof metadata.defaultBranch === "string"
        ? `heads/${metadata.defaultBranch}`
        : ""
      : request.ref.replace(/^refs\/(?=heads\/|tags\/)/u, "");
  if (
    !request.baseCommit &&
    (!requestedRef || requestedRef.length > 1024 || /\p{Cc}/u.test(requestedRef))
  ) {
    throw new Error("GitHub repository has no valid source reference; select a branch or commit.");
  }
  const pinned = request.baseCommit ?? (GitObject.test(requestedRef) ? requestedRef : undefined);
  const commit = await read(
    pinned ? `/git/commits/${pinned}` : `/commits/${encodeURIComponent(requestedRef)}?per_page=1`,
    identity,
    assertAdmission,
    params.signal,
  );
  const baseCommit = objectSha(commit);
  if (pinned && baseCommit !== pinned) {
    sourceChanged();
  }
  const source = { kind: "repository" as const, url, repositoryId, owner };
  const project = readRepositoryWorkerProjectSnapshot({
    key: createHash("sha256")
      .update(stableStringify([params.namespace, source]))
      .digest("hex"),
    baseCommit,
    source,
  });
  if (!project || (expected && !isDeepStrictEqual(project, expected))) {
    sourceChanged();
  }
  const tree = objectSha(
    pinned
      ? isRecord(commit)
        ? commit.tree
        : undefined
      : isRecord(commit) && isRecord(commit.commit)
        ? commit.commit.tree
        : undefined,
  );
  const treeEntry = async (sha: string, name: string) => {
    const value = await read(`/git/trees/${sha}`, identity, assertAdmission, params.signal);
    if (
      !isRecord(value) ||
      objectSha(value) !== sha ||
      value.truncated !== false ||
      !Array.isArray(value.tree)
    ) {
      throw new Error(
        "GitHub tree metadata is incomplete; retry preparation with a complete source.",
      );
    }
    const entries = value.tree.filter((entry) => isRecord(entry) && entry.path === name);
    if (entries.length > 1) {
      sourceChanged();
    }
    return entries[0];
  };
  const knownRecipe = params.knownRecipe?.(structuredClone(project));
  assertAdmission();
  let setupRecipe: string | undefined;
  if (knownRecipe !== undefined) {
    if (
      !isRecord(knownRecipe) ||
      !isDeepStrictEqual(knownRecipe.project, project) ||
      (knownRecipe.setupRecipe !== undefined &&
        (typeof knownRecipe.setupRecipe !== "string" || !GitObject.test(knownRecipe.setupRecipe)))
    ) {
      sourceChanged();
    }
    // Recipe identity, including absence, is immutable for this exact admitted
    // project. Its reuse never substitutes for the surrounding access checks.
    setupRecipe = knownRecipe.setupRecipe;
  } else {
    const directory = await treeEntry(tree, ".openclaw");
    if (isRecord(directory) && directory.type === "tree" && directory.mode === "040000") {
      const recipe = await treeEntry(objectSha(directory), "worktree-setup.sh");
      if (isRecord(recipe) && recipe.type === "blob" && recipe.mode === "100755") {
        setupRecipe = objectSha(recipe);
      }
    }
  }
  // A name can be deleted and recreated while immutable objects are being read.
  // Confirm the repository instance again before advertising reusable capacity.
  const confirmed = await readRepository(identity, assertAdmission, params.signal);
  if (confirmed.private || confirmed.repositoryId !== repositoryId) {
    sourceChanged();
  }
  assertAdmission();
  const revalidate = async (signal?: AbortSignal) => {
    const assertSource = () => {
      signal?.throwIfAborted();
      assertCurrent();
    };
    assertSource();
    const current = await prepareIdentity();
    assertSource();
    if (!isDeepStrictEqual(current.selection, owner.identity)) {
      sourceChanged();
    }
    const before = await readRepository(current, assertSource, signal);
    if (before.private || before.repositoryId !== repositoryId) {
      sourceChanged();
    }
    const observed = await read(`/git/commits/${baseCommit}`, current, assertSource, signal);
    if (objectSha(observed) !== baseCommit) {
      sourceChanged();
    }
    const after = await readRepository(current, assertSource, signal);
    if (after.private || after.repositoryId !== repositoryId) {
      sourceChanged();
    }
    assertSource();
    identity = current;
  };
  return {
    project,
    setupRecipe,
    assertCurrent,
    revalidate,
  };
}
