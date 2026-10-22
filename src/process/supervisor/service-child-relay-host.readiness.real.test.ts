import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { ProcessOutputIncompleteError } from "../decoded-output.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createProcessSupervisor } from "./supervisor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function parentPid(pid: number): number {
  const match = /^PPid:\s+(\d+)$/mu.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  if (!match) {
    throw new Error(`Cannot determine parent PID for ${pid}`);
  }
  return Number(match[1]);
}

it.skipIf(process.platform !== "linux")(
  "preserves exit code 23 when a real relay is stopped with output still open",
  async () => {
    const cwd = tempDirs.make("openclaw-real-relay-output-deadline-");
    const writerPidPath = path.join(cwd, "writer.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const writer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      });
      writeFileSync(${JSON.stringify(writerPidPath)}, String(writer.pid));
      writer.unref();
      setTimeout(() => process.exit(23), 1000);
    `;
    const starting = createServiceChildRelayAdapter({
      command: process.execPath,
      args: ["-e", script],
      cwd,
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
    });
    const { adapter, ready } = await starting;
    await ready;
    adapter.onStdout(() => {});
    adapter.onStderr(() => {});
    expect(adapter.pid).toBeTypeOf("number");
    const relayPid = parentPid(adapter.pid!);
    const rootExit = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
    adapter.onExit((code, signal) => {
      try {
        process.kill(relayPid, "SIGSTOP");
        adapter.kill("SIGKILL");
        rootExit.resolve({ code, signal });
      } catch (error) {
        rootExit.reject(error);
      }
    });
    const outcome = adapter.wait().catch((error: unknown) => error);

    try {
      await expect(rootExit.promise).resolves.toEqual({ code: 23, signal: null });
      const error = await outcome;
      expect(error).toMatchObject({
        name: "ProcessOutputIncompleteError",
        outputComplete: false,
        result: { code: 23, signal: null },
        cause: { message: expect.stringContaining("hard deadline") },
      });
      expect(error).toBeInstanceOf(ProcessOutputIncompleteError);
    } finally {
      try {
        process.kill(relayPid, "SIGCONT");
      } catch {}
      killPidIfAlive(relayPid);
      if (existsSync(writerPidPath)) {
        killPidIfAlive(Number(readFileSync(writerPidPath, "utf8")));
      }
      adapter.dispose();
      await adapter.waitForExtinction().catch(() => undefined);
    }
  },
  15_000,
);

it.skipIf(process.platform === "win32").each(["consume", "cancel"] as const)(
  "drains real relay output while private input is pending: %s",
  async (operation) => {
    const cwd = tempDirs.make("openclaw-relay-readiness-");
    const release = path.join(cwd, "consume");
    const secret = Buffer.alloc(1024 * 1024, 0x5a);
    const expectedHash = createHash("sha256").update(secret).digest("hex");
    const body = "x".repeat(512 * 1024) + "\nfinal tail\n";
    const script = `
      const fs = require("node:fs");
      fs.writeSync(1, "x".repeat(512 * 1024) + "\\nfinal tail\\n");
      fs.writeSync(2, "stderr tail\\n");
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        const data = fs.readFileSync(3);
        fs.writeSync(1, require("node:crypto").createHash("sha256").update(data).digest("hex"));
      }, 10);
    `;
    const supervisor = createProcessSupervisor();
    const closeScope = supervisor.acquireScopeCleanup(cwd, { processTree: "required-all" });
    const observed = { stdout: "", stderr: "", launchGrants: 0, ready: false };
    const nativeAdmission = createDeferredCore();
    const starting = supervisor.spawn({
      mode: "child",
      scopeKey: cwd,
      argv: [process.execPath, "-e", script],
      cwd,
      stdinMode: "pipe-closed",
      timeoutMs: 10_000,
      secretInput: { fd: 3, createData: () => secret },
      initiateSpawn(launch, settlement) {
        observed.launchGrants++;
        if (!settlement) {
          throw new Error("Relay launch did not retain native admission");
        }
        void settlement.then(() => nativeAdmission.resolve(), nativeAdmission.reject);
        return launch();
      },
      onStdout: (chunk) => (observed.stdout += chunk),
      onStderr: (chunk) => (observed.stderr += chunk),
    });
    void starting.then(() => (observed.ready = true), nativeAdmission.reject);
    try {
      await nativeAdmission.promise;
      expect(observed.launchGrants).toBe(1);
      await expect
        .poll(() => observed, { timeout: 5_000 })
        .toEqual({
          stdout: body,
          stderr: "stderr tail\n",
          launchGrants: 1,
          ready: false,
        });
      if (operation === "consume") {
        writeFileSync(release, "consume");
      } else {
        supervisor.cancelScope(cwd);
      }
      expect(await (await starting).wait()).toMatchObject({
        reason: operation === "consume" ? "exit" : "manual-cancel",
        stdout: body + (operation === "consume" ? expectedHash : ""),
        stderr: "stderr tail\n",
      });
      expect(secret.every((byte) => byte === 0)).toBe(true);
      if (operation === "consume") {
        await closeScope();
      } else {
        await expect(closeScope()).rejects.toThrow("construction aborted");
      }
    } finally {
      writeFileSync(release, "consume");
      supervisor.cancelScope(cwd);
      await starting.then(
        (run) => run.wait(),
        () => undefined,
      );
      await closeScope().catch(() => undefined);
    }
  },
  15_000,
);
