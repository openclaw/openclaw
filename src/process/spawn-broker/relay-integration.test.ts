import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { spawnProcess } from "../spawn-utils.js";
import { createServiceChildRelayAdapter } from "../supervisor/service-child-relay-host.js";
import { createProcessSupervisor } from "../supervisor/supervisor.js";
import type { ProcessExtinctionResult } from "../supervisor/types.js";
import { BrokerChild } from "./child.js";
import { spawnServiceChildRelay } from "./relay-integration.js";

vi.mock("../spawn-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spawn-utils.js")>()),
  spawnProcess: vi.fn(),
}));
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

it("launches the stable Homebrew Node after an upgrade removed the running Cellar keg", async () => {
  await withTestDir({ prefix: "openclaw-relay-node-" }, async (prefix) => {
    const stableNode = path.join(prefix, "opt", "node", "bin", "node");
    const workerPath = path.join(prefix, "relay-worker.js");
    await fs.mkdir(path.dirname(stableNode), { recursive: true });
    await fs.writeFile(stableNode, "", "utf8");
    vi.mocked(spawnProcess).mockReturnValue(new ChildProcess());
    const originalExecPath = process.execPath;
    process.execPath = path.join(prefix, "Cellar", "node", "26.8.1", "bin", "node");
    try {
      spawnServiceChildRelay({
        workerUrl: pathToFileURL(workerPath),
        stdio: "ignore",
        env: {},
        detached: false,
      });
    } finally {
      process.execPath = originalExecPath;
    }
    expect(spawnProcess).toHaveBeenLastCalledWith(stableNode, [workerPath], expect.any(Object));
  });
});
