import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

// Native Windows only: this exercises the real Job-backed command runner and
// Windows filesystem/environment, not a stubbed platform or script-only entry.
describe.runIf(process.platform === "win32")("Windows node-host quiescence", () => {
  it("retains one SQLite helper across foreground Job cleanup and fresh-nonce turns, then joins its retirement", async () => {
    const root = fs.realpathSync(tempDirs.make("node-quiescence-win-"));
    const identity = {
      gatewayNamespace: "gateway-windows",
      environmentId: "environment-windows",
      sessionId: "session-windows",
      generation: 1,
    };
    const hash = (value: string, size: number) =>
      createHash("sha256").update(value).digest("hex").slice(0, size);
    const home = path.join(
      root,
      identity.gatewayNamespace,
      "workspaces",
      hash(identity.environmentId, 16),
      hash(identity.sessionId, 32),
    );
    const workspaceDir = path.join(home, "1");
    fs.mkdirSync(workspaceDir, { recursive: true });
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
    const command = (operation: NodeWorkerWorkspaceQuiescenceInput) =>
      runtime.exec(
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({
            ...identity,
            argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, workspaceDir],
            quiescence: operation,
          }),
        ),
      );
    const readLease = () => {
      const database = new DatabaseSync(
        path.join(home, ".openclaw-worker", "quiescence", "windows-shared-host.sqlite"),
        { readOnly: true },
      );
      try {
        const row = database
          .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
          .get(hash(workspaceDir, 64));
        return row ? JSON.parse(String(row.lease_json)) : undefined;
      } finally {
        database.close();
      }
    };
    const nonce = "a".repeat(32);
    const spawned = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    try {
      await expect(command({ action: "acquire", nonce, timeoutMs: 30_000 })).resolves.toMatchObject(
        {
          code: 0,
          stdout: "quiesced " + nonce + "\n",
          workspaceDir,
        },
      );
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
      await expect(
        command({ action: "acquire", nonce: "b".repeat(32), timeoutMs: 30_000 }),
      ).rejects.toThrow("lease is already active");
      await expect(
        command({
          action: "renew",
          nonce: "b".repeat(32),
          timeoutMs: 30_000,
          validationMode: "final",
        }),
      ).rejects.toThrow();
      await expect(command({ action: "release", nonce: "b".repeat(32) })).rejects.toThrow(
        "no longer active",
      );
      expect(readLease()).toEqual(before);
      // App retirement must not retire infrastructure lease control.
      await runtime.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
      await expect(
        command({ action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" }),
      ).resolves.toMatchObject({ code: 0, stdout: "renewed " + nonce + "\n" });
      expect(readLease()).toMatchObject({ nonce, processes: [], watchdog: null });
      await expect(command({ action: "release", nonce })).resolves.toMatchObject({ code: 0 });
      expect(readLease()).toBeUndefined();
      const controlSpawns = spawned.mock.calls.length;
      const nextNonce = "c".repeat(32);
      await command({ action: "acquire", nonce: nextNonce, timeoutMs: 30_000 });
      expect(readLease()).toMatchObject({ nonce: nextNonce, processes: [], watchdog: null });
      for (const action of ["renew", "release"] as const) {
        await expect(
          command(
            action === "renew"
              ? { action, nonce, timeoutMs: 30_000, validationMode: "final" }
              : { action, nonce },
          ),
        ).rejects.toThrow("no longer active");
      }
      await command({
        action: "renew",
        nonce: nextNonce,
        timeoutMs: 30_000,
        validationMode: "final",
      });
      await command({ action: "release", nonce: nextNonce });
      expect(spawned).toHaveBeenCalledTimes(controlSpawns);
      expect(helper.exitCode).toBeNull();
      await runtime.applyRetainSnapshot(
        {
          version: 1,
          gatewayNamespace: identity.gatewayNamespace,
          controllerId: "windows-watchdog-proof",
          sequence: 1,
          retain: [],
        },
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
});
