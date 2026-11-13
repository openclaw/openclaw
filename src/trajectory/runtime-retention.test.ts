import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  OpenClawAgentDatabaseExecution,
} from "../state/openclaw-agent-execution-contract.js";
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
    write: vi.fn<() => Promise<unknown>>(),
    read: vi.fn(),
    releaseReader: vi.fn<() => void>(() => {
      throw readerFailure;
    }),
    releaseExecution: vi.fn<() => Promise<void>>(async () => {
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
// mock-isolation: Cleanup is tested without initializing the shared maintenance worker lane.
vi.mock("../config/sessions/session-transcript-worker-resources.js", () => ({
  maintenanceLane: {},
}));
// mock-isolation: Control read results and cleanup without starting maintenance workers.
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  retainSessionHistoryWorkerDatabase: () => ({
    owner: {
      readTrajectoryRetention: fixture.read,
    },
    release: fixture.releaseReader,
  }),
}));
// mock-isolation: Exercise scheduling against worker outcomes without a live writer broker.
vi.mock("../state/openclaw-agent-write-admission.js", () => ({
  runOpenClawAgentWorkerWrite: () => fixture.write(),
}));
// mock-isolation: Native execution is never admitted; only its cleanup result is injected.
vi.mock("../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: (): OpenClawAgentDatabaseExecution => ({
    agentId: "main",
    path: "unused-retention-execution",
    fileIdentity: undefined,
    onTerminal: () => () => {},
    assertCurrent() {},
    captureGenerationClaim() {
      throw new Error("Unexpected generation capture");
    },
    capturePreparedGenerationClaim: () => undefined,
    async prepare() {
      throw new Error("Unexpected database preparation");
    },
    async adoptNativeDatabase() {
      throw new Error("Unexpected native database adoption");
    },
    async runExisting() {
      throw new Error("Revoked retention must not write");
    },
    release: fixture.releaseExecution,
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.agents.length = 0;
  fixture.roots.length = 0;
  fixture.read.mockReset();
  fixture.write.mockReset();
  fixture.releaseReader.mockImplementation(() => {
    throw fixture.readerFailure;
  });
  fixture.releaseExecution.mockImplementation(async () => {
    throw fixture.executionFailure;
  });
});
afterEach(() => vi.useRealTimers());

function createRequest(directory: string) {
  const pathname = path.join(directory, "agent.sqlite");
  const identity: AgentDatabaseExecutionFileIdentity = {
    kind: "file",
    physicalIdentity: "retention-test",
    nativeLocation: pathname,
  };
  return {
    identity,
    options: { agentId: "main", path: pathname, env: { OPENCLAW_STATE_DIR: directory } },
    input: { sessionId: "current" },
    assertCurrent() {},
  };
}

it("retains failed cleanup custody and exposes the original failure to lifecycle joiners", async () => {
  const request = createRequest(tempDirs.make("trajectory-retention-cleanup-"));
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
  expect(fixture.releaseReader).toHaveBeenCalledOnce();
  expect(fixture.releaseExecution).toHaveBeenCalledOnce();
  expect(fixture.unregisterAgent).not.toHaveBeenCalled();
  expect(fixture.unregisterRoot).not.toHaveBeenCalled();
});

it.each(["refresh", "error"] as const)(
  "coalesces appends and defers an interrupted sweep until the next interval (%s)",
  async (outcome) => {
    const request = createRequest(tempDirs.make("trajectory-retention-cadence-"));
    const now = Date.parse("2026-07-26T00:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    fixture.releaseReader.mockImplementation(() => {});
    fixture.releaseExecution.mockResolvedValue(undefined);
    fixture.read.mockResolvedValue({ runs: [], sessionId: "current", cutoff: 0, maxBytes: 1 });
    const interrupted = { complete: false, refresh: true };
    fixture.write.mockResolvedValueOnce("sweep");
    if (outcome === "refresh") {
      fixture.write.mockResolvedValueOnce(interrupted);
    } else {
      fixture.write.mockRejectedValueOnce(new Error("synthetic retention failure"));
    }
    try {
      const pending = scheduleSqliteTrajectoryRuntimeRetention(request);
      expect(pending).toBeDefined();
      expect(scheduleSqliteTrajectoryRuntimeRetention(request)).toBe(pending);
      await pending;
      expect(fixture.read).toHaveBeenCalledOnce();
      expect(fixture.write).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(now + 60 * 60 * 1_000 - 1);
      expect(scheduleSqliteTrajectoryRuntimeRetention(request)).toBeUndefined();
      expect(fixture.read).toHaveBeenCalledOnce();

      clock.mockReturnValue(now + 60 * 60 * 1_000);
      fixture.write.mockResolvedValueOnce("next-sweep").mockResolvedValueOnce({ complete: true });
      const next = scheduleSqliteTrajectoryRuntimeRetention(request);
      expect(next).toBeDefined();
      await next;
      expect(fixture.read).toHaveBeenCalledTimes(2);
      expect(fixture.write).toHaveBeenCalledTimes(4);
      expect(fixture.releaseExecution).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  },
);
