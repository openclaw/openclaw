import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution-contract.js";
import type { OpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { scheduleSqliteTrajectoryRuntimeRetention } from "./runtime-retention.js";

const fixture = vi.hoisted(() => {
  const agents: OpenClawAgentDatabaseAsyncResource[] = [];
  const roots: OpenClawStateDatabaseAsyncResource[] = [];
  const readerFailure = new Error("synthetic reader close failure");
  const executionFailure = new Error("synthetic execution release failure");
  return {
    agents,
    roots,
    readerFailure,
    executionFailure,
    unregisterAgent: vi.fn(),
    unregisterRoot: vi.fn(),
    releaseDatabase: vi.fn(),
    closeReader: vi.fn(async () => {
      throw readerFailure;
    }),
    releaseExecution: vi.fn(async () => {
      throw executionFailure;
    }),
  };
});

// mock-isolation: Capture lifecycle callbacks without poisoning the real failed-close registries.
vi.mock("../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: (resource: OpenClawAgentDatabaseAsyncResource) => {
    fixture.agents.push(resource);
    return fixture.unregisterAgent;
  },
}));
// mock-isolation: Root cleanup custody is observed independently of the process-wide registry.
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: (resource: OpenClawStateDatabaseAsyncResource) => {
    fixture.roots.push(resource);
    return fixture.unregisterRoot;
  },
}));
// mock-isolation: Observe the scheduler's retained database borrow without opening canonical state.
vi.mock("../state/openclaw-agent-db-lifecycle.js", () => ({
  retainAgentDatabase: () => fixture.releaseDatabase,
}));
// mock-isolation: No root database or schema admission is needed for this cleanup-only contract.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadContext: (pathname: string): OpenClawStateReadContext => ({
    admission: {
      databasePath: pathname,
      coordinationKey: pathname,
      identity: { key: `path:${pathname}`, canonicalPath: pathname },
      assertCurrent() {},
    },
    assertPublicationCurrent() {},
    maintenanceScope: undefined,
    existingSchemaPath: undefined,
    runInCapturedSchemaScope: undefined,
  }),
}));
// mock-isolation: The reader's cleanup fails before any child process or database query is started.
vi.mock("../infra/sqlite-readonly-worker.js", () => ({
  createSqliteReadOnlyWorkerScope: () => ({
    run<T>(operation: () => T): T {
      return operation();
    },
    close: fixture.closeReader,
  }),
  runSqliteReadOnlyOperation: () => {
    throw new Error("Revoked retention must not read");
  },
}));
// mock-isolation: Native execution is never admitted; only its cleanup result is injected.
vi.mock("../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: (): OpenClawAgentDatabaseExecution => ({
    agentId: "main",
    path: "unused-retention-execution",
    fileIdentity: undefined,
    assertCurrent() {},
    captureGenerationClaim() {
      throw new Error("Unexpected generation capture");
    },
    capturePreparedGenerationClaim: () => undefined,
    async prepare() {
      throw new Error("Unexpected database preparation");
    },
    async runExisting() {
      throw new Error("Revoked retention must not write");
    },
    release: fixture.releaseExecution,
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains failed cleanup custody and exposes the original failure to lifecycle joiners", async () => {
  const directory = tempDirs.make("trajectory-retention-cleanup-");
  const pathname = path.join(directory, "agent.sqlite");
  const db = openNodeSqliteDatabase(pathname);
  registerOpenClawAgentDatabaseIdentity(db);
  const database: OpenClawAgentDatabase = {
    agentId: "main",
    db,
    path: pathname,
    walMaintenance: {
      checkpoint() {
        throw new Error("Unexpected checkpoint");
      },
      reclaimFreePages() {
        throw new Error("Unexpected reclamation");
      },
      async stop() {
        throw new Error("Unexpected WAL stop");
      },
      close() {
        throw new Error("Unexpected WAL close");
      },
    },
  };
  const request = {
    database,
    options: { agentId: "main", path: pathname, env: { OPENCLAW_STATE_DIR: directory } },
    input: { sessionId: "current" },
    assertCurrent() {},
  };
  try {
    const pending = scheduleSqliteTrajectoryRuntimeRetention(request);
    assert(pending);
    const agent = fixture.agents[0];
    const root = fixture.roots[0];
    assert(agent && root);
    // Revocation cancels the owned immediate before it can admit native work.
    const closing = agent.close();
    const outcomes = await Promise.allSettled([pending, closing]);
    const original = outcomes[0];
    const joined = outcomes[1];
    assert(original?.status === "rejected" && joined?.status === "rejected");
    expect(original.reason).toMatchObject({
      errors: [fixture.readerFailure, fixture.executionFailure],
    });
    expect(joined.reason).toBe(original.reason);
    await expect(root.close()).rejects.toBe(original.reason);
    expect(scheduleSqliteTrajectoryRuntimeRetention(request)).toBe(pending);
    expect(fixture.closeReader).toHaveBeenCalledOnce();
    expect(fixture.releaseExecution).toHaveBeenCalledOnce();
    expect(fixture.unregisterAgent).not.toHaveBeenCalled();
    expect(fixture.unregisterRoot).not.toHaveBeenCalled();
    expect(fixture.releaseDatabase).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
