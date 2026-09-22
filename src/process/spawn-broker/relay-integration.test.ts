import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { spawnProcess } from "../spawn-utils.js";
import { createServiceChildRelayAdapter } from "../supervisor/service-child-relay-host.js";
import { BrokerChild } from "./child.js";

vi.mock("../spawn-utils.js", () => ({ spawnProcess: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("publishes retained cleanup before a broker transport fails readiness", async () => {
  const child = new BrokerChild(1, [process.execPath], async () => {});
  vi.mocked(spawnProcess).mockReturnValue(child);
  const cleanups: Promise<void>[] = [];
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
