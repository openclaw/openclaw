import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { spawnProcess } from "../spawn-utils.js";
import { bindInheritedNativeProcessOwner } from "../supervisor/inherited-process-lineage.js";
import { createServiceChildRelayAdapter } from "../supervisor/service-child-relay-host.js";
import { prepareServiceChildRelay } from "../supervisor/service-child-relay-preparation.js";
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
    expect(vi.mocked(spawnProcess).mock.lastCall?.slice(0, 2)).toEqual([stableNode, [workerPath]]);
  });
});

it("keeps an embedded relay out of its downloaded worker's generic runtime mode", () => {
  const workerUrl = pathToFileURL(path.resolve("runtime/dist/service-child-relay.mjs"));
  const env = { BUN_BE_BUN: "1", HOME: "/synthetic-worker-home" };
  vi.stubGlobal(
    "__openclawStandaloneIsEmbeddedModule",
    (filename: string) => filename === path.resolve("runtime/dist/service-child-relay.mjs"),
  );
  vi.mocked(spawnProcess).mockReturnValue(new ChildProcess());
  try {
    spawnServiceChildRelay({ workerUrl, stdio: "ignore", env, detached: false });
    expect(vi.mocked(spawnProcess).mock.lastCall?.[2]?.env).toEqual({
      HOME: "/synthetic-worker-home",
    });
    expect(env.BUN_BE_BUN).toBe("1");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("dispatches a direct native owner without generic mode or image inventory", () => {
  const workerUrl = pathToFileURL(path.resolve("runtime/dist/native-anchor.mjs"));
  const env = { BUN_BE_BUN: "1", HOME: "/synthetic-worker-home" };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const release = bindInheritedNativeProcessOwner(workerUrl.href);
  vi.stubGlobal("__openclawStandaloneIsEmbeddedModule", undefined);
  vi.mocked(spawnProcess).mockReturnValue(new ChildProcess());
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    using preparation = prepareServiceChildRelay({
      command: "synthetic-command",
      args: [],
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
    });
    expect(preparation.useLinuxSubreaper).toBe(true);
    spawnServiceChildRelay({ ...preparation.spawn, env });
    expect(vi.mocked(spawnProcess).mock.lastCall?.[2]?.env).toEqual({
      HOME: "/synthetic-worker-home",
    });
    expect(env.BUN_BE_BUN).toBe("1");
  } finally {
    release();
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllGlobals();
  }
});

it.each([undefined, "file:///different/native-anchor.mjs"])(
  "retains generic mode without authority for the selected entry (%s)",
  (nativeProcessOwner) => {
    const workerUrl = pathToFileURL(path.resolve("downloaded-worker.mjs"));
    const env = { BUN_BE_BUN: "1", HOME: "/synthetic-worker-home" };
    vi.stubGlobal("__openclawStandaloneIsEmbeddedModule", undefined);
    vi.mocked(spawnProcess).mockReturnValue(new ChildProcess());
    try {
      const input = {
        workerUrl,
        stdio: "ignore" as const,
        env,
        detached: false,
        nativeProcessOwner,
      };
      spawnServiceChildRelay(input);
      expect(vi.mocked(spawnProcess).mock.lastCall?.[2]?.env).toEqual(env);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
