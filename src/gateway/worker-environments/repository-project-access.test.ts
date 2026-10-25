import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createWorkerEnvironmentAccess } from "./environment-access.js";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
} from "./prepared-pool.test-support.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

const admit = vi.hoisted(() =>
  vi.fn<typeof import("./repository-project-admission.js").prepareRepositoryWorkerProjectSource>(),
);
vi.mock("./repository-project-admission.js", () => ({
  prepareRepositoryWorkerProjectSource: admit,
}));

// Reopening the store must not turn cached content into access.
const fixture = usePreparedPoolFixture();
it.each([
  "reopened store",
  "source unavailable",
  "caller revoked",
  "identity replaced",
  "access lost after binding",
] as const)("revalidates source access during %s binding", async (scenario) => {
  const project: RepositoryWorkerProjectSnapshot = {
    key: PROJECT_KEY,
    baseCommit: "d".repeat(40),
    source: {
      kind: "repository",
      url: "https://github.com/example/prepared.git",
      repositoryId: "R_prepared_fixture",
      owner: { agent: { agentId: "main", provenance: null }, identity: { source: "anonymous" } },
    },
  };
  const record = await fixture.attachSeed("repository", { repository: project });
  if (scenario === "reopened store") {
    await fixture.reopenStore();
  }
  let callerCurrent = true;
  let identityCurrent = true;
  const revalidate = vi.fn(async () => {
    assert(
      scenario !== "access lost after binding",
      new Error("Repository access is no longer available"),
    );
  });
  admit.mockReset().mockImplementation(async (params) => {
    expect([params.expected, params.namespace]).toEqual([project, "gateway"]);
    params.assertCurrent();
    assert(
      scenario !== "source unavailable",
      new Error("Repository access is no longer available"),
    );
    callerCurrent = scenario !== "caller revoked";
    return {
      project,
      setupRecipe: undefined,
      recipe: { source: "none", inputs: {}, env: {} },
      assertCurrent: () => assert(identityCurrent, new Error("Repository identity changed")),
      revalidate,
    };
  });
  const prepared = {
    gatewayNamespace: "gateway",
    environmentId: record.environmentId,
    preparationKey: PREPARATION_KEY,
    cacheKey: "9".repeat(64),
    workspaceDir: "/worker/prepared/workspace",
    homeDir: "/worker/prepared/home",
    sourceManifestRef: `sha256:${"a".repeat(64)}`,
    preparedManifestRef: `sha256:${"b".repeat(64)}`,
  };
  const bind = vi.fn(async (request: { assertCurrent: () => void }) => {
    request.assertCurrent();
    identityCurrent = scenario !== "identity replaced";
    return prepared;
  });
  const access = createWorkerEnvironmentAccess({
    store: fixture.store,
    getCleanupError: () => undefined,
    readStartStatus: () => undefined,
    getConfig: () => fixture.config,
    projectNamespace: "gateway",
    bindPreparedWorkspace: bind,
    prepareCurrentBundle: async () => {
      throw new Error("No tunnel should start during source admission");
    },
    now: () => fixture.nowMs,
    identityResolverFor: () => {
      throw new Error("No SSH identity should be acquired during source admission");
    },
    isStopping: () => false,
    providerFor: () => fixture.provider,
    resolveProvider: () => fixture.provider,
    withLock: async (_id, run) => await run(),
  });
  const result = access.bindPreparedWorkspace({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId: "session:repository",
    sessionKey: "agent:main:session:repository",
    preparationKey: PREPARATION_KEY,
    cacheKey: "9".repeat(64),
    signal: fixture.abort.signal,
    assertCurrent: () => assert(callerCurrent, new Error("Dispatch caller retired")),
  });
  if (scenario === "reopened store") {
    const binding = await result;
    expect(binding).toMatchObject(prepared);
    binding.assertCurrent();
    identityCurrent = false;
    expect(() => binding.assertCurrent()).toThrow("Repository identity changed");
    expect(revalidate).toHaveBeenCalledOnce();
  } else {
    await expect(result).rejects.toThrow(
      scenario === "caller revoked" ? "Dispatch caller retired" : /Repository (access|identity)/u,
    );
  }
  expect(bind).toHaveBeenCalledTimes(
    scenario === "source unavailable" || scenario === "caller revoked" ? 0 : 1,
  );
  expect(admit).toHaveBeenCalledOnce();
  expect(fixture.store.get(record.environmentId)).toEqual(record);
});
