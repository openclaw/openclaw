import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../../agents/agent-lifecycle-registry.js";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertRepositoryDispatchAdmission } from "../repository-dispatch.js";
import type { RepositorySources } from "../repository-sources.js";
import {
  resolveEnvironmentRecipe,
  type EnvironmentRecipe,
  type EnvironmentRecipeEntry,
} from "./environment-recipe.js";
import {
  readRepositoryWorkerProjectSnapshot,
  repositoryWorkerSourceBinding,
} from "./repository-project-source.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

export type RepositoryProjectAdmissionRequest = {
  namespace: string;
  getConfig: () => OpenClawConfig;
  getRepositorySources?: () => RepositorySources;
  assertCurrent: () => void;
  signal?: AbortSignal;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
  knownRecipe?: (
    project: RepositoryWorkerProjectSnapshot,
  ) => { setupRecipe?: string; recipe?: EnvironmentRecipe } | undefined;
} & (
  | {
      repository: {
        agentId: string;
        url: string;
        ref?: string;
        baseCommit?: string;
        repositorySourceId?: string;
      };
      expected?: never;
    }
  | { expected: RepositoryWorkerProjectSnapshot; repository?: never }
);
const GitObject = /^[a-f0-9]{40}$/u;

function sourceChanged(): never {
  throw new Error(
    "Prepared repository identity changed; retry with the current source and account.",
  );
}
/** Core retains agent, recipe and reuse authority; the source owns remote metadata and credentials. */
export async function prepareRepositoryWorkerProjectSource(
  params: RepositoryProjectAdmissionRequest,
) {
  const expected = params.expected && readRepositoryWorkerProjectSnapshot(params.expected);
  const expectedBinding = expected && repositoryWorkerSourceBinding(expected.source);
  const request = expected
    ? {
        agentId: expected.source.owner.agent.agentId,
        url: expected.source.url,
        baseCommit: expected.baseCommit,
        ref: undefined,
        repositorySourceId: expectedBinding?.sourceId,
      }
    : params.repository;
  if (!request || !/^[A-Za-z0-9_-]{1,128}$/u.test(params.namespace)) {
    throw new Error("Repository preparation request is invalid");
  }
  const sources = params.getRepositorySources?.();
  if (!sources) {
    throw new Error("Repository source service is unavailable; retry after Gateway startup.");
  }
  const source = sources.resolve(request.url, request.repositorySourceId);
  const agent =
    expected?.source.owner.agent ??
    (await captureAgentLifecycleBinding(params.getConfig, request.agentId));
  if (!agent) {
    throw new Error("Repository preparation requires an existing agent that is not being deleted");
  }
  const assertCurrent = () => {
    source.assertCurrent();
    assertRepositoryDispatchAdmission(params.readNativeCredential, params.getConfig());
    if (!matchesAgentLifecycleBinding(params.getConfig(), agent)) {
      sourceChanged();
    }
  };
  const assertCaller = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    assertCurrent();
  };
  if (!(await matchesAgentLifecycleBindingAsync(params.getConfig, agent))) {
    sourceChanged();
  }
  assertCaller();
  const lease = await source.prepareWorker({
    readCredential: params.readNativeCredential,
    retainCredentialCleanup: params.retainCredentialCleanup,
    agentId: agent.agentId,
    ref: request.ref,
    baseCommit: request.baseCommit,
    expected:
      expected && expectedBinding
        ? { repositoryId: expected.source.repositoryId, identityKey: expectedBinding.identityKey }
        : undefined,
    signal: params.signal,
    assertCurrent,
  });
  if (
    !GitObject.test(lease.baseCommit) ||
    !GitObject.test(lease.tree) ||
    !lease.identityKey ||
    lease.identityKey.length > 256 ||
    !/^[A-Za-z0-9_+/=-]{1,256}$/u.test(lease.repositoryId) ||
    (request.baseCommit && request.baseCommit !== lease.baseCommit)
  ) {
    throw new Error("Repository source returned invalid immutable project facts.");
  }
  if (
    expected &&
    (lease.repositoryId !== expected.source.repositoryId ||
      lease.identityKey !== expectedBinding?.identityKey)
  ) {
    sourceChanged();
  }
  const assertLease = () => {
    assertCurrent();
    lease.assertCurrent();
  };
  const assertAdmission = () => {
    assertCaller();
    assertLease();
  };
  assertAdmission();
  const sourceFacts = {
    kind: "repository" as const,
    url: source.url,
    repositoryId: lease.repositoryId,
    // Preserve native cache keys and owner facts; the bound plugin lease above
    // independently verifies the original account, repository and pinned commit.
    ...(expected && expected.source.owner.identity.source !== "plugin"
      ? { owner: { agent, identity: expected.source.owner.identity } }
      : {
          owner: { agent, identity: { source: "plugin" as const, key: lease.identityKey } },
          repositorySourceId: source.id,
        }),
  };
  const project = readRepositoryWorkerProjectSnapshot({
    key: createHash("sha256")
      .update(
        stableStringify(
          lease.private
            ? ["private-repository", params.namespace, sourceFacts]
            : [params.namespace, sourceFacts],
        ),
      )
      .digest("hex"),
    baseCommit: lease.baseCommit,
    source: sourceFacts,
  });
  if (!project || (expected && !isDeepStrictEqual(project, expected))) {
    sourceChanged();
  }
  const knownRecipe = params.knownRecipe?.(project);
  assertAdmission();
  if (knownRecipe?.recipe && knownRecipe.recipe.identity !== knownRecipe.setupRecipe) {
    sourceChanged();
  }
  let recipe = knownRecipe?.recipe;
  let setupRecipe = knownRecipe?.setupRecipe;
  const trees = new Map<string, ReturnType<typeof lease.readTree>>();
  const treeEntries = (sha: string) => {
    let pending = trees.get(sha);
    if (!pending) {
      assertAdmission();
      pending = lease.readTree(sha, params.signal);
      trees.set(sha, pending);
    }
    return pending;
  };
  const treeEntry = async (sha: string, name: string) => {
    const entries = (await treeEntries(sha)).filter((entry) => entry.path === name);
    assertAdmission();
    if (entries.length > 1 || (entries[0] && !GitObject.test(entries[0].sha))) {
      sourceChanged();
    }
    return entries[0];
  };
  if (
    knownRecipe === undefined ||
    (recipe?.source === "devcontainer" && recipe.secretNames === undefined)
  ) {
    recipe = await resolveEnvironmentRecipe(
      async (file): Promise<EnvironmentRecipeEntry | undefined> => {
        const segments = file.split("/");
        let directory = lease.tree;
        for (const segment of segments.slice(0, -1)) {
          const entry = await treeEntry(directory, segment);
          if (!entry || entry.type !== "tree" || entry.mode !== "040000") {
            return undefined;
          }
          directory = entry.sha;
        }
        const name = segments.at(-1);
        if (!name) {
          return undefined;
        }
        const entry = await treeEntry(directory, name);
        if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
          return undefined;
        }
        const content =
          file.endsWith("devcontainer.json") || file === "package.json"
            ? await lease.readBlob(entry.sha, params.signal)
            : undefined;
        assertAdmission();
        if (content !== undefined && Buffer.byteLength(content) > 1024 * 1024) {
          throw new Error("Repository environment recipe exceeds its size limit.");
        }
        return {
          blob: entry.sha,
          executable: entry.mode === "100755",
          ...(content === undefined ? {} : { content }),
        };
      },
    );
    setupRecipe = recipe.identity;
  }
  // Reading recipe objects must not turn a changed source into reusable capacity.
  await lease.confirmAdmission();
  assertAdmission();
  const prepareGitPack = lease.prepareGitPack;
  return {
    project,
    setupRecipe,
    recipe,
    assertCurrent: assertLease,
    async revalidate(signal?: AbortSignal) {
      if (!(await matchesAgentLifecycleBindingAsync(params.getConfig, agent))) {
        sourceChanged();
      }
      assertLease();
      await lease.revalidate(signal);
      assertLease();
    },
    ...(prepareGitPack
      ? {
          prepareGitPack: async (input: { temporaryRoot: string; signal: AbortSignal }) => {
            const assertFetchCurrent = () => {
              input.signal.throwIfAborted();
              assertAdmission();
            };
            assertFetchCurrent();
            await lease.revalidate(input.signal);
            assertFetchCurrent();
            const pack = await prepareGitPack({ ...input, assertCurrent: assertFetchCurrent });
            assertFetchCurrent();
            await lease.revalidate(input.signal);
            assertFetchCurrent();
            return pack;
          },
        }
      : {}),
  };
}
