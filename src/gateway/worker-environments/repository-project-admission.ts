import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../../agents/agent-lifecycle-registry.js";
import { GitHubCredentialLookupError } from "../../agents/github-read-identity.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDiagnosticTraceContextFromActiveScope } from "../../infra/diagnostic-trace-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseConfiguredProjectGitUrl } from "../../projects/project-git-url.runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

const GitObject = /^[a-f0-9]{40}$/u;
// Commit lookup requests one changed file; trees are nonrecursive and inspect
// only the root and .openclaw directory. Oversized/truncated metadata is not absence.
const METADATA_MAX_BYTES = 1024 * 1024;
const admissionLog = createSubsystemLogger("gateway/repository-admission");

type AdmissionPhase = "prepare" | "revalidate";
type AdmissionOperation =
  | "identity"
  | "repository_access"
  | "repository_confirm"
  | "pinned_repository"
  | "pinned_commit"
  | "source_ref"
  | "recipe_directory"
  | "recipe_blob";

function startAdmissionTiming(operation: AdmissionOperation, admissionPhase: AdmissionPhase) {
  const trace = createDiagnosticTraceContextFromActiveScope();
  return createStageTimingTracker(undefined, (phase) => {
    admissionLog.info("repository admission phase", {
      traceId: trace.traceId,
      requestSpanId: trace.spanId,
      operation,
      admissionPhase,
      ...phase,
    });
  });
}
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
  readNativeCredential?: import("../../agents/github-credential-reader.js").GitHubCredentialReader;
  knownRecipe?: (
    project: RepositoryWorkerProjectSnapshot,
  ) => { project: RepositoryWorkerProjectSnapshot; setupRecipe?: string } | undefined;
} & (
  | {
      repository: {
        agentId: string;
        url: string;
        ref?: string;
        baseCommit?: string;
        currentBranch?: true;
      };
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

/** A named Current checkout can be recorded before dispatch admits its source. */
export function selectedCurrentCheckoutRef(ref: string, defaultBranch?: string) {
  let requestedRef =
    ref === "HEAD"
      ? defaultBranch
        ? `heads/${defaultBranch}`
        : ""
      : ref.replace(/^refs\/(?=heads\/|tags\/)/u, "");
  if (
    !requestedRef ||
    requestedRef === "heads/" ||
    requestedRef.startsWith("tags/") ||
    requestedRef.startsWith("refs/") ||
    GitObject.test(requestedRef)
  ) {
    throw new Error(
      "Current checkout requires a named branch; use New worktree for a tag or commit.",
    );
  }
  requestedRef = requestedRef.startsWith("heads/") ? requestedRef : `heads/${requestedRef}`;
  if (requestedRef.length > 1024 || /\p{Cc}/u.test(requestedRef)) {
    throw new Error("GitHub repository has no valid source reference; select a branch or commit.");
  }
  return { branch: requestedRef.slice("heads/".length), ref: `refs/${requestedRef}` };
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
  const prepareIdentity = async (phase: AdmissionPhase = "prepare") => {
    assertAgent();
    const config = getConfig();
    const timing = startAdmissionTiming("identity", phase);
    const identity = await timing
      .measure("identityAdmission", () =>
        prepareGitHubReadIdentity({
          config,
          sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
          agentId: agent.agentId,
          getCurrentConfig: getConfig,
          assertActive: assertAgent,
          refresh: () => requestCurrentGitHubOAuthRefresh(agent.agentId),
          readNativeCredential: params.readNativeCredential,
          allowAnonymous: true,
        }),
      )
      .catch((error: unknown) => {
        assertAgent();
        // Fixed lookup diagnostics are safe; arbitrary subprocess output stays private.
        throw error instanceof GitHubIdentityError || error instanceof GitHubCredentialLookupError
          ? error
          : new GitHubIdentityError("unverified");
      });
    assertAgent();
    return identity;
  };
  assertAdmission();
  let identity = await prepareIdentity();
  assertAdmission();
  const admit = async (admittedIdentity = identity) => {
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
      operation: AdmissionOperation,
      suffix: string,
      readIdentity: typeof identity,
      assertOwner: () => void,
      signal?: AbortSignal,
      graphql?: { query: string; variables: Record<string, string> },
      phase: AdmissionPhase = "prepare",
    ): Promise<unknown> => {
      assertOwner();
      const timing = startAdmissionTiming(operation, phase);
      const response = await timing.measure("authenticatedRequest", () =>
        gitHubPublicApi.fetchGitHubApi(
          graphql ? gitHubPublicApi.GITHUB_GRAPHQL_URL : endpoint + suffix,
          fetch,
          readIdentity.token,
          async () => sourceChanged(),
          readIdentity,
          undefined,
          signal,
          graphql,
        ),
      );
      try {
        const trace = createDiagnosticTraceContextFromActiveScope();
        const requestId = response.headers.get("x-github-request-id");
        admissionLog.info("repository admission request", {
          traceId: trace.traceId,
          requestSpanId: trace.spanId,
          operation,
          admissionPhase: phase,
          api: graphql ? "graphql" : "rest",
          status: response.status,
          githubRequestId:
            requestId && /^[A-Za-z0-9:-]{1,128}$/u.test(requestId) ? requestId : undefined,
          outcome: response.status >= 400 ? "rejected" : "responded",
        });
      } catch {
        /* Diagnostics cannot change repository admission. */
      }
      let value: unknown;
      try {
        assertOwner();
        value = await timing.measure("responseBody", () =>
          graphql && readIdentity.token
            ? gitHubPublicApi.readGitHubGraphQLResponse(
                response,
                fetch,
                readIdentity.token,
                METADATA_MAX_BYTES,
              )
            : gitHubPublicApi.readGitHubJsonResponse(response, METADATA_MAX_BYTES),
        );
      } finally {
        await gitHubPublicApi.discardResponse(response);
      }
      await timing.measure("responseIdentityRevalidation", () => readIdentity.revalidate());
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
      phase: AdmissionPhase = "prepare",
      operation: "repository_access" | "repository_confirm" = "repository_access",
    ) =>
      repositoryMetadata(
        await read(operation, "", readIdentity, assertOwner, signal, undefined, phase),
        readIdentity,
      );
    const readPinnedRepository = async (
      repositoryId: string,
      baseCommit: string,
      readIdentity: typeof identity,
      assertOwner: () => void,
      signal?: AbortSignal,
      phase: AdmissionPhase = "prepare",
    ) => {
      if (!readIdentity.token) {
        return undefined;
      }
      let value: unknown;
      try {
        value = await read(
          "pinned_repository",
          "",
          readIdentity,
          assertOwner,
          signal,
          { query: PINNED_REPOSITORY_QUERY, variables: { repositoryId, commit: baseCommit } },
          phase,
        );
      } catch (error) {
        // Native classic tokens can read public REST metadata without the
        // public_repo scope required by GraphQL. Preserve the full REST fence.
        if (!(error instanceof gitHubPublicApi.GitHubGraphQLUnavailableError)) {
          throw error;
        }
        // A refused capability ends this route's admission. Verify the credential
        // again before starting the distinct REST fallback, even inside a read scope.
        await readIdentity.start(() => undefined);
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
          admittedIdentity,
          assertAdmission,
          params.signal,
        )
      : undefined;
    const metadata =
      pinnedRepository?.metadata ??
      (await readRepository(admittedIdentity, assertAdmission, params.signal));
    const repositoryId = metadata.repositoryId;
    if (expected && repositoryId !== expected.source.repositoryId) {
      sourceChanged();
    }
    let requestedRef =
      request.ref === undefined || request.ref === "HEAD"
        ? typeof metadata.defaultBranch === "string"
          ? `heads/${metadata.defaultBranch}`
          : ""
        : request.ref.replace(/^refs\/(?=heads\/|tags\/)/u, "");
    const currentBranch = params.repository?.currentBranch === true;
    if (currentBranch) {
      requestedRef = selectedCurrentCheckoutRef(
        request.ref ?? "HEAD",
        typeof metadata.defaultBranch === "string" ? metadata.defaultBranch : undefined,
      ).ref.slice("refs/".length);
    }
    if (
      !request.baseCommit &&
      (!requestedRef || requestedRef.length > 1024 || /\p{Cc}/u.test(requestedRef))
    ) {
      throw new Error(
        "GitHub repository has no valid source reference; select a branch or commit.",
      );
    }
    const pinned = request.baseCommit ?? (GitObject.test(requestedRef) ? requestedRef : undefined);
    const commit =
      pinnedRepository?.commit ??
      (await read(
        pinned ? "pinned_commit" : "source_ref",
        pinned
          ? `/git/commits/${pinned}`
          : `/commits/${encodeURIComponent(requestedRef)}?per_page=1`,
        admittedIdentity,
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
    const treeEntry = async (sha: string, name: string) => {
      const value = await read(
        name === ".openclaw" ? "recipe_directory" : "recipe_blob",
        `/git/trees/${sha}`,
        admittedIdentity,
        assertAdmission,
        params.signal,
      );
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
    const confirmed = await readRepository(
      admittedIdentity,
      assertAdmission,
      params.signal,
      "prepare",
      "repository_confirm",
    );
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
      const current = await prepareIdentity("revalidate");
      assertSource();
      if (!isDeepStrictEqual(current.selection, owner.identity)) {
        sourceChanged();
      }
      const verify = async (readIdentity = current) => {
        const currentPinnedRepository = await readPinnedRepository(
          repositoryId,
          baseCommit,
          readIdentity,
          assertSource,
          signal,
          "revalidate",
        );
        const before =
          currentPinnedRepository?.metadata ??
          (await readRepository(readIdentity, assertSource, signal, "revalidate"));
        if (before.private !== metadata.private || before.repositoryId !== repositoryId) {
          sourceChanged();
        }
        const observed =
          currentPinnedRepository?.commit ??
          (await read(
            "pinned_commit",
            `/git/commits/${baseCommit}`,
            readIdentity,
            assertSource,
            signal,
            undefined,
            "revalidate",
          ));
        if (
          objectSha(observed) !== baseCommit ||
          (currentPinnedRepository && objectSha(currentPinnedRepository.commit.tree) !== tree)
        ) {
          sourceChanged();
        }
        const after = await readRepository(
          readIdentity,
          assertSource,
          signal,
          "revalidate",
          "repository_confirm",
        );
        if (after.private !== metadata.private || after.repositoryId !== repositoryId) {
          sourceChanged();
        }
        assertSource();
      };
      await (current.withVerifiedRead ? current.withVerifiedRead(verify, assertSource) : verify());
      assertSource();
      identity = current;
    };
    return {
      project,
      ...(currentBranch ? { branch: requestedRef.slice("heads/".length) } : {}),
      setupRecipe,
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
  };
  return identity.withVerifiedRead ? identity.withVerifiedRead(admit, assertAdmission) : admit();
}
