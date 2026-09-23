import { ChildProcess } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { spawnProcess } from "../spawn-utils.js";
import { createServiceChildRelayAdapter } from "../supervisor/service-child-relay-host.js";
import { createProcessSupervisor } from "../supervisor/supervisor.js";
import type { ProcessExtinctionResult } from "../supervisor/types.js";
import { BrokerChild } from "./child.js";

vi.mock("../spawn-utils.js", () => ({ spawnProcess: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("settles a streamless native spawn failure and releases its execution scope", async () => {
  const child = new ChildProcess();
  // Observe the OS error independently from the owner's startup and cleanup promises.
  child.on("error", () => {});
  vi.mocked(spawnProcess).mockReturnValue(child);
  const supervisor = createProcessSupervisor();
  const closeScope = supervisor.acquireScopeCleanup("failed-native-relay", {
    processTree: "owned-only",
  });
  const starting = Promise.allSettled([
    supervisor.spawn({
      mode: "anchored-shell",
      command: "synthetic-command",
      scopeKey: "failed-native-relay",
    }),
  ]);
  const failure = Object.assign(new Error(`spawn ${process.execPath} EMFILE`), { code: "EMFILE" });
  child.emit("error", failure);
  child.emit("close", -24, null);

  const outcome = await starting;
  await expect(closeScope()).resolves.toBeUndefined();
  expect(outcome).toEqual([{ status: "rejected", reason: failure }]);
  await expect(supervisor.shutdown()).resolves.toBeUndefined();
});

it("publishes retained cleanup before a broker transport fails readiness", async () => {
  const child = new BrokerChild(1, [process.execPath], async () => {});
  vi.mocked(spawnProcess).mockReturnValue(child);
  const cleanups: Promise<ProcessExtinctionResult>[] = [];
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const starting = createServiceChildRelayAdapter({
      command: "synthetic-child",
      args: [],
      stdinMode: "pipe-open",
      oomScoreWrapperSelected: false,
      onSpawnCleanup: (cleanup) => cleanups.push(cleanup),
    });
    expect(cleanups).toHaveLength(1);
    const failure = new Error("synthetic broker handoff failed");
    const failedStart = expect(starting).rejects.toBe(failure);
    child.fail(failure);
    await failedStart;
    await nextTurn();
    await nextTurn();
    expect(unhandled).not.toHaveBeenCalled();
    await expect(cleanups[0]).rejects.toBe(failure);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
