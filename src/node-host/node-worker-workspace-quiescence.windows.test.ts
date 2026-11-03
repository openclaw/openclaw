import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND as QUIESCENCE,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.runIf(process.platform === "win32")("retains the Windows quiescence helper", async () => {
  const root = fs.realpathSync(tempDirs.make("node-quiescence-win-"));
  const gatewayNamespace = "win";
  const identity = { gatewayNamespace, environmentId: "env", sessionId: "s1", generation: 1 };
  const runtime = new NodeWorkerWorkspaceRuntime({
    root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      TEMP: root,
      TMP: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });
  const { workspaceDir } = await runtime.exec({
    ...identity,
    argv: [path.basename(process.execPath), "-e", ""],
  });
  const home = path.dirname(workspaceDir);
  const workspaceKey = createHash("sha256").update(workspaceDir).digest("hex");
  const command = (quiescence: NodeWorkerWorkspaceQuiescenceInput) => {
    const input = { ...identity, argv: [QUIESCENCE, workspaceDir], quiescence };
    return runtime.exec(parseNodeWorkerWorkspaceExecInput(JSON.stringify(input)));
  };
  const readLease = () => {
    using database = new DatabaseSync(
      path.join(home, ".openclaw-worker", "quiescence", "windows-shared-host.sqlite"),
      { readOnly: true },
    );
    const query = "SELECT lease_json FROM workspace_leases WHERE workspace_key = ?";
    const row = database.prepare(query).get(workspaceKey);
    return row ? JSON.parse(String(row.lease_json)) : undefined;
  };
  const acquire = (nonce: string) => command({ action: "acquire", nonce, timeoutMs: 30_000 });
  const renew = (nonce: string) =>
    command({ action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" });
  const release = (nonce: string) => command({ action: "release", nonce });
  const nonce = "a".repeat(32);
  const spawned = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    await expect(acquire(nonce)).resolves.toMatchObject({
      code: 0,
      stdout: `quiesced ${nonce}\n`,
      workspaceDir,
    });
    expect(readLease()).toMatchObject({ nonce, sharedHost: true, processes: [], watchdog: null });
    const helperCall = spawned.mock.calls.findIndex(
      ([_command, argv]) => Array.isArray(argv) && argv.includes("owned") && argv.includes(nonce),
    );
    const helperResult = spawned.mock.results[helperCall];
    if (!helperResult || helperResult.type !== "return") {
      throw new Error("the retained SQLite helper was not spawned");
    }
    const helper = helperResult.value;
    expect(helper.connected).toBe(true);
    const before = readLease();
    const foreground = await runtime.exec({
      ...identity,
      nativeProcessOwner: true,
      argv: [
        path.basename(process.execPath),
        "-e",
        String.raw`const child = require("node:child_process").spawn(process.execPath,
  ["-e", 'globalThis.channel = new (require("node:worker_threads").MessageChannel)(); globalThis.channel.port1.on("message", () => {}); globalThis.channel.port1.ref(); process.send("ready")'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => {
  child.disconnect();
  process.stdout.write(JSON.stringify({ home: process.env.USERPROFILE, pid: child.pid }));
  child.unref();
});`,
      ],
    });
    expect(foreground).toMatchObject({ code: 0 });
    const output: unknown = JSON.parse(foreground.stdout);
    if (!isRecord(output) || typeof output.pid !== "number") {
      throw new Error("foreground command did not identify its descendant");
    }
    expect(output.home).toBe(home);
    expect(isPidDefinitelyDead(output.pid)).toBe(true);
    expect(runtime.processes.hasActiveWork()).toBe(false);
    expect(helper.exitCode).toBeNull();
    expect(readLease()).toEqual(before);
    const wrongNonce = "b".repeat(32);
    await expect(acquire(wrongNonce)).rejects.toThrow("lease is already active");
    await expect(renew(wrongNonce)).rejects.toThrow();
    await expect(release(wrongNonce)).rejects.toThrow("no longer active");
    expect(readLease()).toEqual(before);
    // App retirement must not retire infrastructure lease control.
    await runtime.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
    await expect(renew(nonce)).resolves.toMatchObject({ code: 0, stdout: `renewed ${nonce}\n` });
    expect(readLease()).toMatchObject({ nonce, processes: [], watchdog: null });
    await expect(release(nonce)).resolves.toMatchObject({ code: 0 });
    expect(readLease()).toBeUndefined();
    const controlSpawns = spawned.mock.calls.length;
    const nextNonce = "c".repeat(32);
    await acquire(nextNonce);
    expect(readLease()).toMatchObject({ nonce: nextNonce, processes: [], watchdog: null });
    for (const action of [renew, release]) {
      await expect(action(nonce)).rejects.toThrow("no longer active");
    }
    await renew(nextNonce);
    await release(nextNonce);
    expect(spawned).toHaveBeenCalledTimes(controlSpawns);
    expect(helper.exitCode).toBeNull();
    await runtime.applyRetainSnapshot(
      { version: 1, gatewayNamespace, controllerId: "proof", sequence: 1, retain: [] },
      async () => [],
    );
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(helper.exitCode).toBeNull();
    const retired = once(helper, "close");
    await runtime.quiescence.close();
    await retired;
    expect(helper.exitCode).toBe(0);
    expect(runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  } finally {
    await runtime.quiescence.close();
    await runtime.processes.close();
  }
});
