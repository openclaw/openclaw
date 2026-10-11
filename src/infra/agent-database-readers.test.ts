import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { describe, expect, it, vi } from "vitest";
import { reviveAgentDatabases } from "../state/openclaw-agent-db-readers.js";
import {
  applyAgentDatabaseReaderRequest,
  decodeAgentDatabaseReaderRequest,
  encodeAgentDatabaseReaderRequest,
  hasDeletedAgentDatabases,
  isDeletedAgentDatabasePath,
  matchesAgentDatabaseReadCandidatePath,
  registerAgentDatabaseReaderCloser,
} from "./agent-database-readers.js";
import { liveWorkerTaskPools } from "./worker-task-pool-registry.js";

const agentDir = path.resolve("/state/agents/alpha/agent");
const databasePath = path.join(agentDir, "openclaw-agent.sqlite");

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
    const close = {
      kind: "close" as const,
      candidates: [{ path: databasePath }],
      deleted: false as const,
    };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(close))).toEqual(
      close,
    );
    const retained = { ...close, retainedPaths: [databasePath] };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(retained))).toEqual(
      retained,
    );
    const deleted = { ...close, deleted: true as const, agentId: "alpha" };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(deleted))).toEqual(
      deleted,
    );
    expect(
      decodeAgentDatabaseReaderRequest(
        JSON.stringify({
          deleted: close.candidates,
          agentId: "alpha",
          retainedPaths: [databasePath],
        }),
      ),
    ).toEqual(deleted);
    expect(
      decodeAgentDatabaseReaderRequest(
        JSON.stringify({
          candidates: close.candidates,
          retainedPaths: [1],
        }),
      ),
    ).toBeUndefined();
    const revive = { kind: "revive" as const, agentIds: ["alpha"] };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(revive))).toEqual(
      revive,
    );
    expect(
      decodeAgentDatabaseReaderRequest(
        JSON.stringify([{ path: databasePath, scope: "sibling-family" }]),
      ),
    ).toEqual({
      kind: "close",
      candidates: [{ path: databasePath, scope: "sibling-family" }],
      deleted: false,
    });
    expect(decodeAgentDatabaseReaderRequest(undefined)).toBeUndefined();
    expect(decodeAgentDatabaseReaderRequest("state:identity")).toBeUndefined();
    expect(decodeAgentDatabaseReaderRequest(JSON.stringify({ other: [] }))).toBeUndefined();
    expect(decodeAgentDatabaseReaderRequest(JSON.stringify([{ path: 1 }]))).toBeUndefined();
    expect(
      decodeAgentDatabaseReaderRequest(JSON.stringify({ deleted: [{ path: databasePath }] })),
    ).toBeUndefined();
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
    const unregister = registerAgentDatabaseReaderCloser((candidates) => {
      seen.push(candidates.map((candidate) => candidate.path));
    });
    try {
      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: databasePath }],
        deleted: false,
      });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(false);

      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: databasePath }],
        deleted: true,
        agentId: "alpha",
      });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(true);
      expect(hasDeletedAgentDatabases()).toBe(true);
      expect(isDeletedAgentDatabasePath(path.join(agentDir, "other.sqlite"))).toBe(false);
      expect(seen).toEqual([[databasePath], [databasePath]]);

      const external = path.resolve("/external/alpha.sqlite");
      const survivor = `${external}.survivor.sqlite`;
      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: external }],
        deleted: true,
        agentId: "alpha",
      });
      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: survivor }],
        deleted: true,
        agentId: "alpha-other",
      });
      await applyAgentDatabaseReaderRequest({ kind: "revive", agentIds: ["beta"] });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(true);
      await expect(reviveAgentDatabases(["alpha"])).rejects.toThrow("worker close failed");
      expect(hasDeletedAgentDatabases()).toBe(true);
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
      expect(hasDeletedAgentDatabases()).toBe(false);
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
      await expect(
        applyAgentDatabaseReaderRequest({
          kind: "close",
          candidates: [{ path: databasePath }],
          deleted: false,
        }),
      ).rejects.toThrow("reader close failed");
      expect(calls).toEqual(["failing", "healthy"]);
    } finally {
      unregisterFailing();
      unregisterHealthy();
    }
  });
});
