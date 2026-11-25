import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { waitForSqliteReclamationCommit } from "./session-accessor.sqlite-reclamation-commit.js";
import {
  SqliteMutationWorkerRetiredError,
  withSqliteMutationWorkerLifetime,
} from "./session-accessor.sqlite-worker-request.js";

type LifetimeResource = { close: () => Promise<void> };
type AgentLifetimeResource = LifetimeResource & { revoke: () => void };

const boundary = vi.hoisted(() => ({
  agentResources: new Set<AgentLifetimeResource>(),
  stateResources: new Set<LifetimeResource>(),
  beforeUnregister: vi.fn<() => void>(),
  assertStateCurrent: vi.fn<() => void>(),
  native: vi.fn(() => {
    throw new Error("Unexpected native database boundary");
  }),
}));

// mock-isolation: Capture lifetime callbacks without registering synthetic paths in the real agent database owner.
vi.mock("../../state/openclaw-agent-db-lifecycle.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: (resource: AgentLifetimeResource) => {
    boundary.agentResources.add(resource);
    return () => {
      boundary.beforeUnregister();
      boundary.agentResources.delete(resource);
    };
  },
}));
// mock-isolation: Exercise request retirement without opening the shared-state database or its process-wide cache.
vi.mock("../../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: () => ({
    identity: { key: "synthetic-state" },
    assertCurrent: boundary.assertStateCurrent,
  }),
  registerOpenClawStateDatabaseAsyncResource: (resource: LifetimeResource) => {
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
      expect(request.signal.reason).not.toBeInstanceOf(SqliteMutationWorkerRetiredError);
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

it.each(["agent", "state", "caller"] as const)(
  "keeps %s retirement or cancellation distinct while joining the active request",
  async (source) => {
    type Request = Parameters<Parameters<typeof withSqliteMutationWorkerLifetime>[1]>[0];
    const entered = createDeferredCore<Request>();
    const release = createDeferredCore();
    const caller = new AbortController();
    const callerReason = new Error("caller cancelled the mutation");
    const operation = withSqliteMutationWorkerLifetime(
      { agentId: "main", path: "/synthetic/agent.sqlite", env: {} },
      async (request) => {
        entered.resolve(request);
        await release.promise;
        request.assertCurrent();
      },
      caller.signal,
    );
    let closing: Promise<void> | undefined;
    try {
      const request = await entered.promise;
      const agent = [...boundary.agentResources][0]!;
      const state = [...boundary.stateResources][0]!;
      if (source === "caller") {
        caller.abort(callerReason);
      }
      if (source === "state") {
        closing = state.close();
      } else {
        agent.revoke();
        closing = agent.close();
      }
      expect(await Promise.race([closing, Promise.resolve("pending")])).toBe("pending");
      if (source === "caller") {
        expect(request.signal.reason).toBe(callerReason);
      } else {
        expect(request.signal.reason).toBeInstanceOf(SqliteMutationWorkerRetiredError);
      }
      const rejected = expect(operation).rejects.toBe(request.signal.reason);
      release.resolve();
      await Promise.all([rejected, closing]);
    } finally {
      release.resolve();
      await Promise.allSettled([operation, closing]);
    }
  },
);
