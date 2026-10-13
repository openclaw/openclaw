import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { waitForSqliteReclamationCommit } from "./session-accessor.sqlite-reclamation-commit.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";

const boundary = vi.hoisted(() => ({
  agentResources: new Set<object>(),
  stateResources: new Set<object>(),
  beforeUnregister: vi.fn<() => void>(),
  assertStateCurrent: vi.fn<() => void>(),
  native: vi.fn(() => {
    throw new Error("Unexpected native database boundary");
  }),
}));

vi.mock("../../state/openclaw-agent-db-lifecycle.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: (resource: object) => {
    boundary.agentResources.add(resource);
    return () => {
      boundary.beforeUnregister();
      boundary.agentResources.delete(resource);
    };
  },
}));
vi.mock("../../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: () => ({
    identity: { key: "synthetic-state" },
    assertCurrent: boundary.assertStateCurrent,
  }),
  registerOpenClawStateDatabaseAsyncResource: (resource: object) => {
    boundary.stateResources.add(resource);
    return () => {
      boundary.beforeUnregister();
      boundary.stateResources.delete(resource);
    };
  },
}));
vi.mock("../../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: () => "/synthetic/shared.sqlite",
}));
vi.mock("../../state/openclaw-agent-db-validation-cache.js", () => ({
  adoptOpenClawAgentDatabaseValidation: boundary.native,
  getOpenClawAgentDatabaseValidation: boundary.native,
}));
vi.mock("../../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: boundary.native,
}));
vi.mock("../../infra/sqlite-busy-timeout.js", () => ({
  setSqliteBusyTimeout: boundary.native,
}));
vi.mock("../../infra/sqlite-error-diagnostics.js", () => ({
  isSqliteLockError: boundary.native,
}));
vi.mock("../../infra/sqlite-transaction.js", () => ({
  runSqliteImmediateTransactionSync: boundary.native,
  withSqliteWriteAdmissionService: boundary.native,
}));

afterEach(() => {
  expect(boundary.agentResources.size).toBe(0);
  expect(boundary.stateResources.size).toBe(0);
  expect(boundary.native).not.toHaveBeenCalled();
  boundary.beforeUnregister.mockReset();
  vi.clearAllMocks();
});

it.each(["fulfills", "rejects"] as const)(
  "revokes saved authority before unregistering when the callback %s",
  async (outcome) => {
    type Request = Parameters<Parameters<typeof withSqliteMutationWorkerLifetime>[1]>[0];
    const entered = createDeferredCore<Request>();
    const release = createDeferredCore();
    const failure = new Error("callback failed");
    const operation = withSqliteMutationWorkerLifetime(
      { agentId: "main", path: "/synthetic/agent.sqlite", env: {} },
      async (request) => {
        request.assertCurrent();
        entered.resolve(request);
        await release.promise;
        if (outcome === "rejects") {
          throw failure;
        }
        return "finished";
      },
    );
    try {
      const request = await entered.promise;
      expect(request.assertCurrent).not.toThrow();
      expect(boundary.agentResources.size).toBe(1);
      expect(boundary.stateResources.size).toBe(1);
      boundary.beforeUnregister.mockImplementation(() => {
        expect.soft(request.assertCurrent).toThrow("SQLite mutation Worker request was revoked");
      });
      release.resolve();
      if (outcome === "rejects") {
        await expect(operation).rejects.toBe(failure);
      } else {
        await expect(operation).resolves.toBe("finished");
      }
      expect(boundary.beforeUnregister).toHaveBeenCalledTimes(2);
      expect.soft(request.assertCurrent).toThrow("SQLite mutation Worker request was revoked");
      const commitRequest = vi.fn(() => {
        // An original, still-open gate reaches this callback; never enter Atomics.wait.
        throw new Error("Commit request escaped its finished lifetime");
      });
      expect
        .soft(() => waitForSqliteReclamationCommit(request.commitGate, commitRequest))
        .toThrow("SQLite session reclamation commit was revoked");
      expect(commitRequest).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await operation.catch(() => undefined);
    }
  },
);
