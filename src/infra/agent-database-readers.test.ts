import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { describe, expect, it, vi } from "vitest";
import { reviveAgentDatabases } from "../state/openclaw-agent-db-readers.js";
import {
  applyAgentDatabaseReaderRequest as applyRequest,
  decodeAgentDatabaseReaderRequest as decodeRequest,
  encodeAgentDatabaseReaderRequest as encodeRequest,
  captureDeletedAgentDatabaseFences,
  isDeletedAgentDatabasePath,
  matchesAgentDatabaseReadCandidatePath,
  registerAgentDatabaseReaderCloser,
  type AgentDatabaseReaderRequest,
} from "./agent-database-readers.js";
import { liveWorkerTaskPools } from "./worker-task-pool-registry.js";

const agentDir = path.resolve("/state/agents/alpha/agent");
const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
const candidates = [{ path: databasePath }];
const close = { kind: "close", candidates, deleted: false } satisfies AgentDatabaseReaderRequest;
const decode = (value: unknown) => decodeRequest(JSON.stringify(value));
function expectRoundTrip(request: AgentDatabaseReaderRequest) {
  expect(decodeRequest(encodeRequest(request))).toEqual(request);
}
function deleteDatabase(pathname = databasePath, agentId = "alpha") {
  return applyRequest({
    kind: "close",
    candidates: [{ path: pathname }],
    deleted: true,
    agentId,
  });
}

describe("agent database reader requests", () => {
  it.each([
    { scope: undefined, target: "openclaw-agent.sqlite", matches: true },
    { scope: undefined, target: "openclaw-agent.memory.sqlite", matches: false },
    { scope: "sibling-family", target: "openclaw-agent.memory.sqlite", matches: true },
    { scope: "sibling-family", target: "unrelated.sqlite", matches: false },
  ] as const)("matches=$matches for $target with scope=$scope", ({ scope, target, matches }) => {
    expect(
      matchesAgentDatabaseReadCandidatePath(
        { path: databasePath, ...(scope ? { scope } : {}) },
        path.join(agentDir, target),
      ),
    ).toBe(matches);
  });

  it("round-trips close, deletion, and revive requests and rejects foreign keys", () => {
    expectRoundTrip(close);
    expectRoundTrip({ ...close, retainedPaths: [databasePath] });
    const deleted = { ...close, deleted: true as const, agentId: "alpha" };
    expectRoundTrip(deleted);
    expect(
      decode({ deleted: candidates, agentId: "alpha", retainedPaths: [databasePath] }),
    ).toEqual(deleted);
    expect(decode({ candidates, retainedPaths: [1] })).toBeUndefined();
    expectRoundTrip({ kind: "revive", agentIds: ["alpha"] });
    const siblings = [{ path: databasePath, scope: "sibling-family" as const }];
    expect(decode(siblings)).toEqual({ ...close, candidates: siblings });
    expect(decodeRequest(undefined)).toBeUndefined();
    expect(decodeRequest("state:identity")).toBeUndefined();
    expect(decode({ other: [] })).toBeUndefined();
    expect(decode([{ path: 1 }])).toBeUndefined();
    expect(decode({ deleted: [{ path: databasePath }] })).toBeUndefined();
  });

  it("runs every registered closer and keeps deleted databases closed until revived", async () => {
    const seen: string[][] = [];
    const pool = liveWorkerTaskPools.register({
      startCloseResources: vi
        .fn(() => {
          const completion = createRetainedOperation<void>(() => {});
          completion.resolve();
          return completion.operation;
        })
        .mockImplementationOnce(() => {
          const completion = createRetainedOperation<void>(() => {});
          completion.reject(new Error("worker close failed"));
          return completion.operation;
        }),
    });
    const unregister = registerAgentDatabaseReaderCloser((selected) => {
      seen.push(selected.map((candidate) => candidate.path));
    });
    try {
      await applyRequest(close);
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(false);

      await deleteDatabase();
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(true);
      expect(captureDeletedAgentDatabaseFences()).toEqual([[databasePath, "alpha"]]);
      expect(isDeletedAgentDatabasePath(path.join(agentDir, "other.sqlite"))).toBe(false);
      expect(seen).toEqual([[databasePath], [databasePath]]);

      const external = path.resolve("/external/alpha.sqlite");
      const survivor = `${external}.survivor.sqlite`;
      await deleteDatabase(external);
      await deleteDatabase(survivor, "alpha-other");
      await applyRequest({ kind: "revive", agentIds: ["beta"] });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(true);
      await expect(reviveAgentDatabases(["alpha"])).rejects.toThrow("worker close failed");
      expect(captureDeletedAgentDatabaseFences()).toEqual([[survivor, "alpha-other"]]);
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(false);
      expect(isDeletedAgentDatabasePath(external)).toBe(false);
      await reviveAgentDatabases(["alpha"]);
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(false);
      expect(isDeletedAgentDatabasePath(external)).toBe(false);
      expect(isDeletedAgentDatabasePath(survivor)).toBe(true);
      expect(pool.startCloseResources).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(4);
      await reviveAgentDatabases(["alpha"]);
      expect(isDeletedAgentDatabasePath(survivor)).toBe(true);
      await reviveAgentDatabases(["alpha-other"]);
      expect(captureDeletedAgentDatabaseFences()).toEqual([]);
    } finally {
      unregister();
      await liveWorkerTaskPools.close(pool, [], async () => {});
    }
  });

  it("surfaces closer failures after running the remaining closers", async () => {
    const calls: string[] = [];
    const unregisterFailing = registerAgentDatabaseReaderCloser(() => {
      calls.push("failing");
      throw new Error("reader close failed");
    });
    const unregisterHealthy = registerAgentDatabaseReaderCloser(() => {
      calls.push("healthy");
    });
    try {
      await expect(applyRequest(close)).rejects.toThrow("reader close failed");
      expect(calls).toEqual(["failing", "healthy"]);
    } finally {
      unregisterFailing();
      unregisterHealthy();
    }
  });
});
