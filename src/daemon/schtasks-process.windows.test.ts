import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isErrno } from "../infra/errno.js";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import { renderCmdSetAssignment } from "./cmd-set.js";
import { buildTaskScript, encodeWindowsLauncherScript } from "./schtasks-layout.js";
import { findInstalledProcessPid, readWindowsProcessSnapshot } from "./schtasks-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

it.skipIf(process.platform !== "win32")(
  "matches a live process with Unicode paths and arguments through hidden PowerShell",
  async () => {
    const directory = tempDirs.make("openclaw-cim-réseau-网卡-🚀-%%-^!-");
    const script = path.join(directory, "gateway-é.mjs");
    await fs.writeFile(script, 'process.send("ready"); process.on("message", () => {});\n');
    const programArguments = [
      process.execPath,
      script,
      "gateway",
      "--port",
      "18789",
      "--fixture-name",
      "réseau 网卡 🚀 e\u0301",
    ];
    const child = spawn(process.execPath, programArguments.slice(1), {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    try {
      const [ready] = await once(child, "message");
      expect(ready).toBe("ready");
      vi.mocked(spawnSync).mockClear();
      const started = performance.now();
      const snapshot = readWindowsProcessSnapshot();
      const elapsedMs = performance.now() - started;
      const call = vi.mocked(spawnSync).mock.results.at(-1);
      const native = call?.type === "return" ? call.value : undefined;
      const error = native?.error;
      let jsonOutput = "not-parsed-native-failure";
      if (native && !error && native.status === 0) {
        try {
          const text = String(native.stdout ?? "").trim();
          const value: unknown = JSON.parse(text || "[]");
          jsonOutput = !text ? "empty" : Array.isArray(value) ? "array" : typeof value;
        } catch {
          jsonOutput = "invalid-json";
        }
      }
      // Preserve the original native result without logging process command lines or credentials.
      console.info(
        "[windows-cim-snapshot]",
        JSON.stringify({
          elapsedMs,
          capturedNativeResult: native !== undefined,
          errorCode: isErrno(error) ? error.code : null,
          status: native?.status,
          signal: native?.signal,
          stdoutBytes: Buffer.byteLength(native?.stdout ?? ""),
          stderrBytes: Buffer.byteLength(native?.stderr ?? ""),
          jsonOutput,
          snapshotEntries: snapshot?.length ?? null,
        }),
      );
      vi.mocked(spawnSync).mockClear();
      expect(snapshot).not.toBeNull();
      if (!snapshot || child.pid === undefined) {
        throw new Error("Expected the live Unicode fixture and its native process snapshot");
      }
      expect(snapshot.find((entry) => entry.ProcessId === child.pid)?.CommandLine).toContain(
        script,
      );
      expect(findInstalledProcessPid(snapshot, 18789, programArguments, () => true)).toBe(
        child.pid,
      );
    } finally {
      await stopChildProcess(child, 5_000);
      await closed;
    }
  },
  30_000,
);

it
  .skipIf(process.platform !== "win32")
  .for(["production renderer", "disabled-expansion control"] as const)(
  "preserves literal CMD argument data with %s",
  { timeout: 30_000 },
  async (mode, context) => {
    const lifetime = createFixtureLifetime();
    context.onTestFinished(() => lifetime.cleanup());
    return lifetime.run(async () => {
      const directory = lifetime.createTempDir("openclaw-cmd-argv-");
      const literal = "réseau %% ^!";
      const workingDirectory = path.join(directory, literal);
      await fs.mkdir(workingDirectory);
      // ASCII relative paths isolate argument encoding from script lookup.
      const programArguments = [process.execPath, "argv-probe.cjs", literal];
      await fs.writeFile(
        path.join(workingDirectory, "argv-probe.cjs"),
        "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), value: process.env.OPENCLAW_TEST_LITERAL, pid: process.pid, ppid: process.ppid }));\n",
      );
      const content =
        mode === "production renderer"
          ? buildTaskScript({
              programArguments,
              workingDirectory,
              environment: { OPENCLAW_TEST_LITERAL: literal },
            })
          : [
              "@echo off",
              "setlocal DisableDelayedExpansion",
              `cd /d ${quoteCmdScriptArg(workingDirectory, { delayedExpansion: false })}`,
              renderCmdSetAssignment("OPENCLAW_TEST_LITERAL", literal, { delayedExpansion: false }),
              programArguments
                .map((argument) => quoteCmdScriptArg(argument, { delayedExpansion: false }))
                .join(" ") + " < NUL",
              "",
            ].join("\r\n");
      const script = encodeWindowsLauncherScript({ format: "cmd", content });
      await fs.writeFile(path.join(directory, "argv-probe.cmd"), script);
      const outputLimit = 8 * 1024;
      const supervisor = createProcessSupervisor();
      const closeScope = supervisor.acquireScopeCleanup(directory, { processTree: "required-all" });
      const cancel = () => supervisor.cancelScope(directory);
      context.signal.addEventListener("abort", cancel, { once: true });
      let outputBytes = 0;
      const countOutput = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > outputLimit) {
          cancel();
        }
      };
      try {
        const run = await lifetime.track(
          supervisor.spawn({
            mode: "child",
            scopeKey: directory,
            argv: [
              getWindowsCmdExePath(),
              "/d",
              "/s",
              "/v:off",
              "/c",
              '""%OPENCLAW_TASK_SCRIPT%""',
            ],
            cwd: directory,
            env: { ...resolveDiagnosticProcessEnv(), OPENCLAW_TASK_SCRIPT: "argv-probe.cmd" },
            exactEnv: true,
            windowsVerbatimArguments: true,
            stdinMode: "pipe-closed",
            timeoutMs: 10_000,
            maxCapturedOutputChars: outputLimit,
            beforeSpawn: () => context.signal.throwIfAborted(),
            onStdoutRaw: countOutput,
            onStderrRaw: countOutput,
          }),
        );
        const result = await lifetime.track(run.wait());
        const extinction = await lifetime.track(run.waitForExtinction?.() ?? Promise.resolve());
        console.info(
          "[windows-cmd-argv]",
          JSON.stringify({
            mode,
            content,
            scriptBase64: script.toString("base64"),
            exitCode: result.exitCode,
            exitSignal: result.exitSignal,
            reason: result.reason,
            extinction,
            outputBytes,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        );
        expect(extinction, "CMD diagnostics require confirmed native Windows Job cleanup").toEqual({
          status: "confirmed",
        });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(outputBytes, "CMD diagnostic output exceeded its capture bound").toBeLessThanOrEqual(
          outputLimit,
        );
        const observed: unknown = JSON.parse(result.stdout);
        expect(observed).toMatchObject({ argv: [literal], cwd: workingDirectory, value: literal });
      } finally {
        context.signal.removeEventListener("abort", cancel);
        await lifetime.verifyCleanup(closeScope);
      }
    });
  },
);
