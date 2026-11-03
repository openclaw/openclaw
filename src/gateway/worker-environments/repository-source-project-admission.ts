import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../../agents/agent-lifecycle-registry.js";
import type { RepositoryTreeEntry } from "../../plugins/repository-source-types.js";
import { resolvePluginRepositorySource } from "../../plugins/repository-sources.js";
import { resolveEnvironmentRecipe, type EnvironmentRecipeEntry } from "./environment-recipe.js";
import type { RepositoryProjectAdmissionRequest } from "./repository-project-admission.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";

const GitObject = /^[a-f0-9]{40}$/u;

/** Native admission retains agent, recipe, reuse, and lifetime ownership; the plugin owns remote I/O. */
export async function preparePluginRepositoryWorkerProject(
  params: RepositoryProjectAdmissionRequest,
) {
  const expected = params.expected && readRepositoryWorkerProjectSnapshot(params.expected);
  const request = expected
    ? {
        agentId: expected.source.owner.agent.agentId,
        url: expected.source.url,
        baseCommit: expected.baseCommit,
        repositorySourceId: expected.source.repositorySourceId,
        ref: undefined,
      }
    : params.repository;
  if (!request?.repositorySourceId || !/^[A-Za-z0-9_-]{1,128}$/u.test(params.namespace)) {
    throw new Error("Repository preparation request is invalid");
  }
  const agent =
    expected?.source.owner.agent ??
    (await captureAgentLifecycleBinding(params.getConfig, request.agentId));
  if (!agent || !(await matchesAgentLifecycleBindingAsync(params.getConfig, agent))) {
    throw new Error("Repository preparation requires an existing agent that is not being deleted");
  }
  const assertAgent = () => {
    if (!matchesAgentLifecycleBinding(params.getConfig(), agent)) {
      throw new Error("Prepared repository agent changed; retry preparation.");
    }
  };
  const assertAdmission = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    assertAgent();
  };
  assertAdmission();
  const source = resolvePluginRepositorySource(request.repositorySourceId, request.url);
  const priorIdentity = expected?.source.owner.identity;
  if (priorIdentity && priorIdentity.source !== "plugin") {
    throw new Error("Repository source identity changed; retry preparation.");
  }
  const lease = await source.prepareWorker({
    readCredential: params.readNativeCredential,
    retainCredentialCleanup: params.retainCredentialCleanup,
    agentId: agent.agentId,
    ref: request.ref,
    baseCommit: request.baseCommit,
    ...(expected && priorIdentity?.source === "plugin"
      ? { expected: { repositoryId: expected.source.repositoryId, identityKey: priorIdentity.key } }
      : {}),
    signal: params.signal,
    assertCurrent: assertAgent,
  });
  assertAdmission();
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
  const assertCurrent = () => {
    assertAgent();
    source.assertCurrent();
    lease.assertCurrent();
  };
  const facts = {
    kind: "repository" as const,
    url: source.url,
    repositorySourceId: source.id,
    repositoryId: lease.repositoryId,
    owner: { agent, identity: { source: "plugin" as const, key: lease.identityKey } },
  };
  const project = readRepositoryWorkerProjectSnapshot({
    key: createHash("sha256")
      .update(
        stableStringify(
          lease.private
            ? ["private-repository", params.namespace, facts]
            : [params.namespace, facts],
        ),
      )
      .digest("hex"),
    baseCommit: lease.baseCommit,
    source: facts,
  });
  if (!project || (expected && !isDeepStrictEqual(project, expected))) {
    throw new Error("Prepared repository source changed; retry with its current identity.");
  }
  const knownRecipe = params.knownRecipe?.(project);
  if (knownRecipe?.recipe && knownRecipe.recipe.identity !== knownRecipe.setupRecipe) {
    throw new Error("Prepared repository recipe no longer matches its admission.");
  }
  let recipe = knownRecipe?.recipe;
  let setupRecipe = knownRecipe?.setupRecipe;
  if (
    knownRecipe === undefined ||
    (recipe?.source === "devcontainer" && recipe.secretNames === undefined)
  ) {
    const trees = new Map<string, Promise<RepositoryTreeEntry[]>>();
    const entryAt = async (sha: string, name: string) => {
      let entries = trees.get(sha);
      if (!entries) {
        entries = lease.readTree(sha, params.signal);
        trees.set(sha, entries);
      }
      const matches = (await entries).filter((entry) => entry.path === name);
      assertAdmission();
      assertCurrent();
      if (matches.length > 1 || (matches[0] && !GitObject.test(matches[0].sha))) {
        throw new Error("Repository source returned invalid tree metadata.");
      }
      return matches[0];
    };
    recipe = await resolveEnvironmentRecipe(
      async (file): Promise<EnvironmentRecipeEntry | undefined> => {
        let directory = lease.tree;
        const segments = file.split("/");
        for (const segment of segments.slice(0, -1)) {
          const entry = await entryAt(directory, segment);
          if (!entry || entry.type !== "tree" || entry.mode !== "040000") {
            return undefined;
          }
          directory = entry.sha;
        }
        const name = segments.at(-1);
        const entry = name ? await entryAt(directory, name) : undefined;
        if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
          return undefined;
        }
        const content =
          file.endsWith("devcontainer.json") || file === "package.json"
            ? await lease.readBlob(entry.sha, params.signal)
            : undefined;
        assertAdmission();
        assertCurrent();
        if (content !== undefined && Buffer.byteLength(content) > 1024 * 1024) {
          throw new Error("Repository environment recipe exceeds its size limit.");
        }
        return {
          blob: entry.sha,
          executable: entry.mode === "100755",
          ...(content !== undefined ? { content } : {}),
        };
      },
    );
    setupRecipe = recipe.identity;
  }
  await lease.confirmAdmission();
  assertAdmission();
  assertCurrent();
  const revalidate = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    assertCurrent();
    await lease.revalidate(signal);
    signal?.throwIfAborted();
    assertCurrent();
  };
  const prepareGitPack = lease.prepareGitPack;
  return {
    project,
    setupRecipe,
    recipe,
    assertCurrent,
    revalidate,
    ...(prepareGitPack
      ? {
          async prepareGitPack(input: { temporaryRoot: string; signal: AbortSignal }) {
            const assertFetchCurrent = () => {
              input.signal.throwIfAborted();
              assertAdmission();
              assertCurrent();
            };
            assertFetchCurrent();
            await revalidate(input.signal);
            assertFetchCurrent();
            const pack = await prepareGitPack({ ...input, assertCurrent: assertFetchCurrent });
            assertFetchCurrent();
            await revalidate(input.signal);
            assertFetchCurrent();
            return pack;
          },
        }
      : {}),
  };
}
