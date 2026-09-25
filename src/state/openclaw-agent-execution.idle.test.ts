import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { revokeAgentDatabaseResources } from "./openclaw-agent-db-resources.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import {
  captureOpenClawAgentDatabaseExecution,
  getOpenClawAgentDatabaseCleanupFailures,
} from "./openclaw-agent-execution.js";

const fixture = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => fixture }));
vi.mock("./agent-database-admission.js", () => ({ assertAgentDatabaseAdmitted: vi.fn() }));
vi.mock("./agent-deletion-cleanup.js", () => ({
  getAgentDeletionDatabaseCleanup: () => undefined,
}));
vi.mock("./openclaw-agent-db-lease.js", () => ({
  hasAgentDatabaseMaintenanceAuthority: () => false,
}));
vi.mock("./openclaw-agent-db-lifecycle.js", () => ({
  agentDatabaseLifecycle: { pending: new Map() },
}));
vi.mock("./openclaw-agent-db.paths.js", () => ({
  isIncognitoOpenClawAgentSqlitePath: () => false,
  resolveOpenClawAgentSqlitePath: (options: { path: string }) => options.path,
}));
vi.mock("./openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
  observeOpenClawDatabaseMaintenanceResource: vi.fn(),
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: () => () => undefined,
}));
vi.mock("./openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: {
      databasePath: "idle-test-state.sqlite",
      identity: { key: "idle-test-state" },
      assertCurrent: vi.fn(),
    },
    environment: {},
  }),
}));
vi.mock("./openclaw-agent-execution-native.js", () => ({
  createAgentDatabaseNativeGeneration: vi.fn(),
}));

const createNative = vi.mocked(createAgentDatabaseNativeGeneration);
const closes = new Map<string, ReturnType<typeof vi.fn<() => Promise<void>>>>();
const borrowed: ReturnType<typeof captureOpenClawAgentDatabaseExecution>[] = [];
const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission: () => {
    throw new Error("Native admission is outside this owner test");
  },
};
function borrow(agentId: string) {
  const execution = captureOpenClawAgentDatabaseExecution({
    agentId,
    path: path.resolve("idle-owner-test", `${agentId}.sqlite`),
  });
  borrowed.push(execution);
  return execution;
}
async function run(execution: ReturnType<typeof borrow>, authority = source) {
  return execution.runExisting(authority, async () => "committed");
}
beforeEach(() => {
  fixture.warn.mockClear();
  createNative.mockReset().mockImplementation((agentId) => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    closes.set(agentId, close);
    return {
      failed: () => false,
      close,
      async run(authority, operation, assertCallerCurrent) {
        authority.assertCurrent();
        assertCallerCurrent?.();
        return operation({ execute: vi.fn() });
      },
    };
  });
});
afterEach(async () => {
  for (const close of closes.values()) {
    close.mockResolvedValue(undefined);
  }
  await Promise.all(borrowed.splice(0).map((execution) => execution.release()));
  await Promise.all(revokeAgentDatabaseResources({}));
  closes.clear();
});

it.each(["eviction", "timer"] as const)(
  "isolates failed idle cleanup during %s while retaining exact retry custody",
  async (trigger) => {
    vi.useFakeTimers();
    try {
      const first = borrow("first");
      expect(await run(first)).toBe("committed");
      await first.release();
      const close = closes.get("first")!;
      const failure = new Error("controlled native close failure");
      close.mockRejectedValue(failure);
      if (trigger === "timer") {
        await vi.advanceTimersByTimeAsync(60_000);
      }

      const second = borrow("second");
      expect(await run(second)).toBe("committed");
      await second.release();
      expect(close).toHaveBeenCalledTimes(1);
      expect(closes.get("second")).toHaveBeenCalledTimes(1);
      const third = borrow("third");
      expect(await run(third)).toBe("committed");
      await third.release();
      // Unrelated turns neither retry the failed close nor retain extra idle natives.
      expect(close).toHaveBeenCalledTimes(1);
      expect(closes.get("third")).toHaveBeenCalledTimes(1);

      const original = borrow("first");
      await expect(run(original)).rejects.toBe(failure);
      expect(createNative).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(2);
      close.mockResolvedValue(undefined);
      expect(await run(original)).toBe("committed");
      expect(close).toHaveBeenCalledTimes(3);
      expect(createNative).toHaveBeenCalledTimes(4);
      expect(fixture.warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["resolve", "reject"] as const)(
  "rechecks caller authority after another owner cleanup %ss",
  async (settlement) => {
    const first = borrow("first");
    await run(first);
    await first.release();
    const cleanup = createDeferredCore();
    const entered = createDeferredCore();
    closes.get("first")!.mockImplementation(() => {
      entered.resolve();
      return cleanup.promise;
    });
    let current = true;
    const second = borrow("second");
    const pending = run(second, {
      ...source,
      assertCurrent() {
        if (!current) {
          throw new Error("request revoked");
        }
      },
    });
    const refused = expect(pending).rejects.toThrow("request revoked");
    await entered.promise;
    current = false;
    if (settlement === "resolve") {
      cleanup.resolve();
    } else {
      cleanup.reject(new Error("close failed"));
    }
    await refused;
    expect(createNative).toHaveBeenCalledTimes(1);
  },
);

it("keeps explicit drainage fail-closed until the retained native cleanup succeeds", async () => {
  const first = borrow("first");
  await run(first);
  await first.release();
  const close = closes.get("first")!;
  close.mockRejectedValue(new Error("native cleanup refused"));
  const selection = { agentId: "first", path: first.path };
  await expect(Promise.all(revokeAgentDatabaseResources(selection))).rejects.toThrow(
    "native cleanup refused",
  );
  expect(() => borrow("first")).toThrow("admission is closed");
  expect(createNative).toHaveBeenCalledTimes(1);
  close.mockResolvedValue(undefined);
  await Promise.all(revokeAgentDatabaseResources(selection));
  expect(await run(borrow("first"))).toBe("committed");
  expect(createNative).toHaveBeenCalledTimes(2);
});

it.each(["single", "aggregate"] as const)(
  "projects redacted %s cleanup failures only for their shared database",
  async (shape) => {
    const first = borrow("first");
    await run(first);
    await first.release();
    const native = Object.assign(
      new Error("native close refused; Authorization: Bearer synthetic-cleanup-secret"),
      { code: "SQLITE_BUSY" },
    );
    const failure =
      shape === "single"
        ? native
        : new AggregateError(
            [native, new Error("lease retained")],
            "Agent database cleanup failed",
          );
    closes.get("first")!.mockRejectedValue(failure);
    expect(getOpenClawAgentDatabaseCleanupFailures("idle-test-state.sqlite")).toEqual([]);
    await run(borrow("second"));
    expect(getOpenClawAgentDatabaseCleanupFailures("other-state.sqlite")).toEqual([]);
    const failures = getOpenClawAgentDatabaseCleanupFailures("idle-test-state.sqlite");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      agentId: "first",
      repairHint: expect.stringContaining("restart the Gateway"),
    });
    expect(failures[0]!.reason).toContain("native close refused");
    expect(failures[0]!.reason).toContain("SQLITE_BUSY");
    expect(failures[0]!.reason).not.toContain("synthetic-cleanup-secret");
    expect(fixture.warn).toHaveBeenCalledOnce();
    expect(fixture.warn.mock.calls[0]![0]).toContain("native close refused");
    expect(fixture.warn.mock.calls[0]![0]).not.toContain("synthetic-cleanup-secret");
    closes.get("first")!.mockResolvedValue(undefined);
    await run(borrow("first"));
    expect(getOpenClawAgentDatabaseCleanupFailures("idle-test-state.sqlite")).toEqual([]);
  },
);
