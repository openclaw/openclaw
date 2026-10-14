import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../../agents/agent-lifecycle-registry.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseConfiguredProjectGitUrl } from "../../projects/project-git-url.runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { gitHubPublicApi } from "../github-public-api.js";
import {
  EnvironmentRecipeSchema,
  resolveEnvironmentRecipe,
  type EnvironmentRecipe,
  type EnvironmentRecipeEntry,
} from "./environment-recipe.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

const GitObject = /^[a-f0-9]{40}$/u;
// Commit lookup requests one changed file; trees are nonrecursive and inspect
// only the root and recipe directories. Oversized/truncated metadata is not absence.
const METADATA_MAX_BYTES = 1024 * 1024;
// Bind object resolution to the immutable repository, never its reusable name.
const PINNED_REPOSITORY_QUERY = `query PinnedRepository($repositoryId: ID!, $commit: GitObjectID!) {
  node(id: $repositoryId) {
    __typename
    ... on Repository {
      node_id: id
      clone_url: url
      private: isPrivate
      object(oid: $commit) {
        __typename
        ... on Commit { sha: oid tree { sha: oid } }
      }
    }
  }
}`;
type AdmissionRequest = {
  namespace: string;
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal?: AbortSignal;
  knownRecipe?: (
    project: RepositoryWorkerProjectSnapshot,
  ) =>
    | { project: RepositoryWorkerProjectSnapshot; setupRecipe?: string; recipe?: EnvironmentRecipe }
    | undefined;
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

/** Admit source before capacity selection; credentials remain with this Gateway owner. */
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
  const url = parseConfiguredProjectGitUrl(request.url)?.url;
  if (!url || (request.baseCommit !== undefined && !GitObject.test(request.baseCommit))) {
    throw new Error("Repository preparation requires a GitHub URL and a valid pinned commit");
  }
  const agent =
    expected?.source.owner.agent ??
    (await captureAgentLifecycleBinding(params.getConfig, request.agentId));
  if (!agent) {
    throw new Error("Repository preparation requires an existing agent that is not being deleted");
  }
  const getConfig = params.getConfig;
  const assertAgent = () => {
    if (!matchesAgentLifecycleBinding(getConfig(), agent)) {
      sourceChanged();
    }
  };
  const assertAgentPrepared = async () => {
    if (!(await matchesAgentLifecycleBindingAsync(getConfig, agent))) {
      sourceChanged();
    }
  };
  const assertCaller = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  const assertAdmission = () => {
    assertCaller();
    assertAgent();
  };
  const prepareIdentity = async (assertPreparationCurrent: () => void) => {
    await assertAgentPrepared();
    assertPreparationCurrent();
    const config = getConfig();
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId: agent.agentId,
      getCurrentConfig: getConfig,
      assertActive: assertAgent,
      refresh: () => requestCurrentGitHubOAuthRefresh(agent.agentId),
      allowAnonymous: true,
    }).catch(async (error: unknown) => {
      await assertAgentPrepared();
      // Native credential subprocess diagnostics must never enter provider errors.
      throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
    });
    assertAgent();
    return identity;
  };
  await assertAgentPrepared();
  assertAdmission();
  let identity = await prepareIdentity(assertCaller);
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
  const endpoint = `${gitHubPublicApi.GITHUB_API_BASE_URL}/repos${repositoryPath}`;
  const read = async (
    suffix: string,
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
    graphql?: { query: string; variables: Record<string, string> },
  ): Promise<unknown> => {
    assertOwner();
    const response = await gitHubPublicApi.fetchGitHubApi(
      graphql ? gitHubPublicApi.GITHUB_GRAPHQL_URL : endpoint + suffix,
      fetch,
      readIdentity.token,
      async () => sourceChanged(),
      readIdentity,
      undefined,
      signal,
      graphql,
    );
    let value: unknown;
    try {
      assertOwner();
      value =
        graphql && readIdentity.token
          ? await gitHubPublicApi.readGitHubGraphQLResponse(
              response,
              fetch,
              readIdentity.token,
              METADATA_MAX_BYTES,
            )
          : await gitHubPublicApi.readGitHubJsonResponse(response, METADATA_MAX_BYTES);
    } finally {
      await gitHubPublicApi.discardResponse(response);
    }
    await readIdentity.revalidate();
    assertOwner();
    return value;
  };
  const repositoryMetadata = (value: unknown, readIdentity: typeof identity) => {
    if (
      !isRecord(value) ||
      typeof value.node_id !== "string" ||
      !/^[A-Za-z0-9_+/=-]{1,256}$/u.test(value.node_id) ||
      typeof value.clone_url !== "string" ||
      parseConfiguredProjectGitUrl(value.clone_url)?.url !== url ||
      typeof value.private !== "boolean" ||
      (value.private && (readIdentity.selection.source === "anonymous" || !readIdentity.token))
    ) {
      sourceChanged();
    }
    return {
      repositoryId: value.node_id,
      defaultBranch: value.default_branch,
      private: value.private,
    };
  };
  const readRepository = async (
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
  ) => repositoryMetadata(await read("", readIdentity, assertOwner, signal), readIdentity);
  const readPinnedRepository = async (
    repositoryId: string,
    baseCommit: string,
    readIdentity: typeof identity,
    assertOwner: () => void,
    signal?: AbortSignal,
  ) => {
    if (!readIdentity.token) {
      return undefined;
    }
    let value: unknown;
    try {
      value = await read("", readIdentity, assertOwner, signal, {
        query: PINNED_REPOSITORY_QUERY,
        variables: { repositoryId, commit: baseCommit },
      });
    } catch (error) {
      // Native classic tokens can read public REST metadata without the
      // public_repo scope required by GraphQL. Preserve the full REST fence.
      if (!(error instanceof gitHubPublicApi.GitHubGraphQLUnavailableError)) {
        throw error;
      }
      await readIdentity.revalidate();
      assertOwner();
      return undefined;
    }
    const node = isRecord(value) && isRecord(value.data) ? value.data.node : undefined;
    if (!isRecord(node) || node.__typename !== "Repository" || node.node_id !== repositoryId) {
      sourceChanged();
    }
    const metadata = repositoryMetadata(node, readIdentity);
    const commit = node.object;
    // Missing objects return null without GraphQL errors, including absent SHAs.
    if (!isRecord(commit) || commit.__typename !== "Commit" || objectSha(commit) !== baseCommit) {
      sourceChanged();
    }
    objectSha(commit.tree);
    return { metadata, commit };
  };
  const pinnedRepository = expected
    ? await readPinnedRepository(
        expected.source.repositoryId,
        expected.baseCommit,
        identity,
        assertAdmission,
        params.signal,
      )
    : undefined;
  const metadata =
    pinnedRepository?.metadata ?? (await readRepository(identity, assertAdmission, params.signal));
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
  const commit =
    pinnedRepository?.commit ??
    (await read(
      pinned ? `/git/commits/${pinned}` : `/commits/${encodeURIComponent(requestedRef)}?per_page=1`,
      identity,
      assertAdmission,
      params.signal,
    ));
  const baseCommit = objectSha(commit);
  if (pinned && baseCommit !== pinned) {
    sourceChanged();
  }
  const source = { kind: "repository" as const, url, repositoryId, owner };
  // GitHub Enterprise can report internal repositories as non-private even
  // though anonymous Git transport is unavailable. Keep credential-free worker
  // clones limited to public github.com repositories; enterprise source always
  // uses the temporary authenticated pack path on the Gateway.
  const requiresGitPack = metadata.private || new URL(url).hostname !== "github.com";
  const project = readRepositoryWorkerProjectSnapshot({
    key: createHash("sha256")
      // Preserve public cache keys, but never reinterpret them as private content.
      .update(
        stableStringify(
          metadata.private
            ? ["private-repository", params.namespace, source]
            : [params.namespace, source],
        ),
      )
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
  const trees = new Map<string, Promise<Record<string, unknown>[]>>();
  const treeEntries = (sha: string) => {
    let pending = trees.get(sha);
    if (pending) {
      return pending;
    }
    pending = readTree(sha);
    trees.set(sha, pending);
    return pending;
  };
  const readTree = async (sha: string) => {
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
    return value.tree.filter(isRecord);
  };
  const treeEntry = async (sha: string, name: string) => {
    const entries = (await treeEntries(sha)).filter((entry) => entry.path === name);
    if (entries.length > 1) {
      sourceChanged();
    }
    return entries[0];
  };
  const knownRecipe = params.knownRecipe?.(structuredClone(project));
  assertAdmission();
  let setupRecipe: string | undefined;
  let recipe: EnvironmentRecipe | undefined;
  if (knownRecipe !== undefined) {
    if (!isRecord(knownRecipe)) {
      sourceChanged();
    }
    const parsedRecipe =
      knownRecipe.recipe === undefined
        ? undefined
        : EnvironmentRecipeSchema.safeParse(knownRecipe.recipe);
    if (
      !isDeepStrictEqual(knownRecipe.project, project) ||
      (knownRecipe.setupRecipe !== undefined &&
        (typeof knownRecipe.setupRecipe !== "string" ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(knownRecipe.setupRecipe))) ||
      (parsedRecipe !== undefined &&
        (!parsedRecipe.success || parsedRecipe.data.identity !== knownRecipe.setupRecipe))
    ) {
      sourceChanged();
    }
    // Recipe identity, including absence, is immutable for this exact admitted
    // project. Its reuse never substitutes for the surrounding access checks.
    setupRecipe = knownRecipe.setupRecipe;
    recipe = parsedRecipe?.success ? parsedRecipe.data : undefined;
  }
  // Older devcontainer parsing did not record secret requests, including an empty selection.
  if (
    knownRecipe === undefined ||
    (recipe?.source === "devcontainer" && recipe.secretNames === undefined)
  ) {
    recipe = await resolveEnvironmentRecipe(
      async (file): Promise<EnvironmentRecipeEntry | undefined> => {
        const segments = file.split("/");
        let directory = tree;
        for (const segment of segments.slice(0, -1)) {
          const entry = await treeEntry(directory, segment);
          if (!entry || entry.type !== "tree" || entry.mode !== "040000") {
            return undefined;
          }
          directory = objectSha(entry);
        }
        const name = segments.at(-1);
        if (!name) {
          return undefined;
        }
        const entry = await treeEntry(directory, name);
        if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))) {
          return undefined;
        }
        const blob = objectSha(entry);
        const needsContent = file.endsWith("devcontainer.json") || file === "package.json";
        let content: string | undefined;
        if (needsContent) {
          const value = await read(`/git/blobs/${blob}`, identity, assertAdmission, params.signal);
          if (
            !isRecord(value) ||
            objectSha(value) !== blob ||
            value.encoding !== "base64" ||
            typeof value.content !== "string" ||
            typeof value.size !== "number" ||
            value.size < 0 ||
            value.size > METADATA_MAX_BYTES
          ) {
            throw new Error(
              "GitHub returned invalid environment recipe content; retry preparation.",
            );
          }
          const decoded = Buffer.from(value.content, "base64");
          if (decoded.length !== value.size || decoded.length > METADATA_MAX_BYTES) {
            throw new Error(
              "GitHub returned incomplete environment recipe content; retry preparation.",
            );
          }
          content = decoded.toString("utf8");
        }
        return {
          blob,
          executable: entry.mode === "100755",
          ...(content === undefined ? {} : { content }),
        };
      },
    );
    setupRecipe = recipe.identity;
  }
  // A name can be deleted and recreated while immutable objects are being read.
  // Confirm the repository instance again before advertising reusable capacity.
  const confirmed = await readRepository(identity, assertAdmission, params.signal);
  if (confirmed.private !== metadata.private || confirmed.repositoryId !== repositoryId) {
    sourceChanged();
  }
  assertAdmission();
  const revalidate = async (signal?: AbortSignal) => {
    const assertSource = () => {
      signal?.throwIfAborted();
      assertCurrent();
    };
    assertSource();
    const current = await prepareIdentity(() => signal?.throwIfAborted());
    assertSource();
    if (!isDeepStrictEqual(current.selection, owner.identity)) {
      sourceChanged();
    }
    const currentPinnedRepository = await readPinnedRepository(
      repositoryId,
      baseCommit,
      current,
      assertSource,
      signal,
    );
    const before =
      currentPinnedRepository?.metadata ?? (await readRepository(current, assertSource, signal));
    if (before.private !== metadata.private || before.repositoryId !== repositoryId) {
      sourceChanged();
    }
    const observed =
      currentPinnedRepository?.commit ??
      (await read(`/git/commits/${baseCommit}`, current, assertSource, signal));
    if (
      objectSha(observed) !== baseCommit ||
      (currentPinnedRepository && objectSha(currentPinnedRepository.commit.tree) !== tree)
    ) {
      sourceChanged();
    }
    const after = await readRepository(current, assertSource, signal);
    if (after.private !== metadata.private || after.repositoryId !== repositoryId) {
      sourceChanged();
    }
    assertSource();
    identity = current;
  };
  return {
    project,
    setupRecipe,
    recipe,
    assertCurrent,
    revalidate,
    ...(requiresGitPack
      ? {
          prepareGitPack: async (input: { temporaryRoot: string; signal: AbortSignal }) => {
            assertAdmission();
            await revalidate(input.signal);
            const readIdentity = identity;
            const assertFetchCurrent = () => {
              input.signal.throwIfAborted();
              assertAdmission();
              readIdentity.assertSelected();
            };
            const token = readIdentity.token;
            if (!token) {
              throw new GitHubIdentityError("unavailable");
            }
            const { prepareRepositoryWorkerGitPack } = await import("./repository-git-pack.js");
            assertFetchCurrent();
            const pack = await prepareRepositoryWorkerGitPack({
              ...input,
              url,
              baseCommit,
              token,
              assertCurrent: assertFetchCurrent,
            });
            assertFetchCurrent();
            await revalidate(input.signal);
            assertAdmission();
            return pack;
          },
        }
      : {}),
  };
}
