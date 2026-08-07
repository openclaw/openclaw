// Check Deadcode Unused Files tests cover check deadcode unused files script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  checkKnipUnusedFileScanResult,
  checkUnusedFiles,
  KNIP_MAX_BUFFER_BYTES,
  parseKnipCompactUnusedFiles,
  runKnipUnusedFiles,
} from "../../scripts/check-deadcode-unused-files.mjs";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForPidFile,
} from "../helpers/process-wait.js";

class FakeKnipProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  readonly unref = vi.fn();
  exitCode: number | null = null;
  pid = 12345;
  signalCode: NodeJS.Signals | null = null;
}

// Windows cleanup can spend 10s each on graceful and forced taskkill attempts.
const KNIP_CLI_FIXTURE_TIMEOUT_MS = 30_000;

function finishFakeProcess(
  child: FakeKnipProcess,
  status: number | null,
  signal: NodeJS.Signals | null,
): void {
  child.exitCode = status;
  child.signalCode = signal;
  child.emit("exit", status, signal);
  child.emit("close", status, signal);
}

function readRecordedPid(pidPath: string): number {
  if (!existsSync(pidPath)) {
    return 0;
  }
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function expectSingleFinalFailureTrailer(stderr: string): void {
  const lines = stderr.trim().split(/\r?\n/u);
  expect(lines.filter((line) => line.startsWith("[deadcode] FAILED"))).toEqual([
    "[deadcode] FAILED (exit 1)",
  ]);
  expect(lines.at(-1)).toBe("[deadcode] FAILED (exit 1)");
}

function runKnipCliFixture({
  childSource,
  extraEnv,
  preloadSource,
}: {
  childSource: string;
  extraEnv?: NodeJS.ProcessEnv;
  preloadSource?: string;
}): { exitMarker: string; status: number | null; stderr: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-cli-"));
  const exitMarkerPath = path.join(root, "exit-marker");
  const pnpmExecPath = path.join(root, "pnpm.cjs");
  const preloadPath = path.join(root, "preload.mjs");

  try {
    writeFileSync(pnpmExecPath, childSource, "utf8");
    const nodeArgs = [];
    if (preloadSource) {
      writeFileSync(preloadPath, preloadSource, "utf8");
      nodeArgs.push("--import", pathToFileURL(preloadPath).href);
    }
    nodeArgs.push(path.resolve("scripts/deadcode-knip-runner.mjs"));

    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        npm_execpath: pnpmExecPath,
        OPENCLAW_TEST_EXIT_MARKER: exitMarkerPath,
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: KNIP_CLI_FIXTURE_TIMEOUT_MS,
    });

    if (result.error) {
      throw result.error;
    }
    return {
      exitMarker: existsSync(exitMarkerPath) ? readFileSync(exitMarkerPath, "utf8") : "",
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-deadcode-unused-files", () => {
  it("has no checked-in unused-file allowlist", () => {
    expect(existsSync(path.resolve("scripts/deadcode-unused-files.allowlist.mjs"))).toBe(false);
    const script = readFileSync(path.resolve("scripts/check-deadcode-unused-files.mjs"), "utf8");
    expect(script).not.toContain("allowlist");
    expect(script).toContain("production and full-tree unused-file checks passed with 0 entries");
    expect(script).toContain('"config/knip.all-exports.config.ts"');
    expect(script).toContain("result.status !== 0");
  });

  it("parses the compact Knip unused-file section", () => {
    expect(
      parseKnipCompactUnusedFiles(`
> openclaw@2026.4.27 deadcode:knip /repo
> pnpm dlx knip --reporter compact --files

Unused files (2)
src/b.ts: src/b.ts
src/a.ts: src/a.ts
C:\\tmp\\outside.ts: C:\\tmp\\outside.ts
C:outside.ts: C:outside.ts
\\\\server\\share\\outside.ts: \\\\server\\share\\outside.ts

Unused dependencies (1)
left-pad: package.json
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses Knip's files-only compact output", () => {
    expect(parseKnipCompactUnusedFiles("src/b.ts: src/b.ts\nsrc/a.ts: src/a.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("keeps dot-directory and root entry files", () => {
    expect(
      parseKnipCompactUnusedFiles(
        ".agents/skills/example/scripts/check.mjs: .agents/skills/example/scripts/check.mjs\ntsdown.ai.config.ts: tsdown.ai.config.ts\n",
      ),
    ).toEqual([".agents/skills/example/scripts/check.mjs", "tsdown.ai.config.ts"]);
  });

  it("ignores pnpm dlx progress lines in files-only compact output", () => {
    expect(
      parseKnipCompactUnusedFiles(`
Progress: resolved 21, reused 0, downloaded 0, added 0
src/b.ts: src/b.ts
Progress: resolved 65, reused 20, downloaded 1, added 21, done
src/a.ts: src/a.ts
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accepts an empty compact report with zero unused files", () => {
    expect(checkUnusedFiles("")).toStrictEqual({
      files: [],
      ok: true,
      message: "",
    });
  });

  it("rejects a nonzero Knip exit even when no unused files were printed", () => {
    expect(
      checkKnipUnusedFileScanResult({
        errorCode: undefined,
        output: "",
        signal: null,
        status: 2,
      }),
    ).toStrictEqual({
      failureReason: "exit status 2",
      message: "",
      ok: false,
    });
  });

  it("rejects every unused file without an allowlist", () => {
    expect(
      checkUnusedFiles("Unused files (2)\nsrc/z.ts: src/z.ts\nsrc/a.ts: src/a.ts\n"),
    ).toStrictEqual({
      files: ["src/a.ts", "src/z.ts"],
      ok: false,
      message: `Unused files are not allowed:
  src/a.ts
  src/z.ts
Delete the files or model their real entrypoints in Knip.`,
    });
  });

  it("runs Knip through a process-group-aware subprocess", async () => {
    const calls: unknown[] = [];
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-runner-"));
    const pnpmExecPath = path.join(root, "pnpm.cjs");
    writeFileSync(pnpmExecPath, "console.log('pnpm');\n", "utf8");

    try {
      const resultPromise = runKnipUnusedFiles({
        nodeExecPath: "/test-node",
        npmExecPath: pnpmExecPath,
        spawnCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          const child = new FakeKnipProcess();
          queueMicrotask(() => {
            child.stdout.emit("data", "partial stdout");
            child.stderr.emit("data", "partial stderr");
            finishFakeProcess(child, 0, null);
          });
          return child;
        },
        writeStatus: () => {},
      });

      const result = await resultPromise;

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        args: [
          pnpmExecPath,
          "--config.minimum-release-age=0",
          "dlx",
          "--package",
          "knip@6.8.0",
          "knip",
          "--config",
          "config/knip.config.ts",
          "--production",
          "--no-progress",
          "--reporter",
          "compact",
          "--files",
          "--no-config-hints",
        ],
        command: "/test-node",
        options: {
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      });
      expect(result).toStrictEqual({
        errorCode: undefined,
        errorMessage: undefined,
        output: "partial stdoutpartial stderr",
        signal: null,
        status: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to bare pnpm when no managed pnpm runner is available", async () => {
    const calls: unknown[] = [];

    const resultPromise = runKnipUnusedFiles({
      env: { PATH: "" },
      npmExecPath: "",
      platform: "linux",
      spawnCommand(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        const child = new FakeKnipProcess();
        queueMicrotask(() => finishFakeProcess(child, 0, null));
        return child;
      },
      writeStatus: () => {},
    });

    await resultPromise;

    const call = calls[0] as { command: string };
    expect(path.basename(call.command)).toBe("pnpm");
    expect(call).toMatchObject({
      args: [
        "--config.minimum-release-age=0",
        "dlx",
        "--package",
        "knip@6.8.0",
        "knip",
        "--config",
        "config/knip.config.ts",
        "--production",
        "--no-progress",
        "--reporter",
        "compact",
        "--files",
        "--no-config-hints",
      ],
      options: {
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
  });

  it.each([
    {
      name: "POSIX structural keys",
      platform: "linux" as const,
      structuralEnv: {
        PNPM_CONFIG_MODULES_DIR: "/upper-modules",
        PNPM_CONFIG_VIRTUAL_STORE_DIR: "/upper-virtual-store",
        pnpm_config_modules_dir: "/lower-modules",
        pnpm_config_virtual_store_dir: "/lower-virtual-store",
        NPM_CONFIG_MODULES_DIR: "/npm-upper-modules",
        NPM_CONFIG_VIRTUAL_STORE_DIR: "/npm-upper-virtual-store",
        npm_config_modules_dir: "/npm-lower-modules",
        npm_config_virtual_store_dir: "/npm-lower-virtual-store",
      },
    },
    {
      name: "Windows mixed-case structural keys",
      platform: "win32" as const,
      structuralEnv: {
        PnPm_CoNfIg_MoDuLeS_DiR: "C:\\mixed-modules",
        pNpM_cOnFiG_vIrTuAl_StOrE_dIr: "C:\\mixed-virtual-store",
        NpM_cOnFiG_mOdUlEs_DiR: "C:\\npm-mixed-modules",
        nPm_CoNfIg_ViRtUaL_sToRe_DiR: "C:\\npm-mixed-virtual-store",
      },
    },
  ])("removes $name only from the Knip child environment", async ({ platform, structuralEnv }) => {
    const child = new FakeKnipProcess();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const preservedEnv = {
      PATH: "",
      NPM_CONFIG_CACHE: "/npm-upper-cache",
      NPM_CONFIG_REGISTRY: "https://npm-upper-registry.example.test/",
      NPM_CONFIG_STORE_DIR: "/npm-upper-store",
      PNPM_CONFIG_STORE_DIR: "/store",
      npm_config_cache: "/npm-lower-cache",
      npm_config_registry: "https://npm-lower-registry.example.test/",
      npm_config_store_dir: "/npm-lower-store",
      "npm_config_//npm.example.test/:_authToken": "npm-token-value",
      pnpm_config_cache_dir: "/cache",
      PNPM_CONFIG_REGISTRY: "https://registry.example.test/",
      "pnpm_config_//registry.example.test/:_authToken": "token-value",
      OPENCLAW_TEST_VALUE: "keep-me",
    };

    const resultPromise = runKnipUnusedFiles({
      env: { ...structuralEnv, ...preservedEnv },
      npmExecPath: "",
      platform,
      spawnCommand(_command: string, _args: string[], options: unknown) {
        spawnedEnv = (options as { env?: NodeJS.ProcessEnv }).env;
        queueMicrotask(() => finishFakeProcess(child, 0, null));
        return child;
      },
      writeStatus: () => {},
    });

    await expect(resultPromise).resolves.toMatchObject({ status: 0 });
    expect(spawnedEnv).toStrictEqual(preservedEnv);
  });

  it("emits heartbeat status and reports Knip timeouts", async () => {
    const statuses: string[] = [];
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    const kills: Array<NodeJS.Signals | number | undefined> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        if (signal === 0) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        kills.push(signal);
        finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const result = await runKnipUnusedFiles({
        heartbeatMs: 1,
        killGraceMs: 50,
        maxBufferBytes: KNIP_MAX_BUFFER_BYTES,
        platform: "linux",
        spawnCommand: () => child,
        timeoutMs: 5,
        writeStatus: (message: string) => statuses.push(message),
      });

      expect(statuses.some((message) => message.includes("still running"))).toBe(true);
      expect(statuses.some((message) => message.includes("timed out"))).toBe(true);
      expect(kills).toContain("SIGTERM");
      expect(result).toStrictEqual({
        errorCode: "ETIMEDOUT",
        errorMessage: expect.stringContaining("Knip production unused-file scan timed out"),
        output: "",
        signal: "SIGTERM",
        status: null,
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it("settles a POSIX timeout without close after graceful escalation", async () => {
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    const kills: NodeJS.Signals[] = [];
    let childAlive = true;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -child.pid) {
        if (signal === 0) {
          if (childAlive) {
            return true;
          }
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        kills.push(signal as NodeJS.Signals);
        if (signal === "SIGKILL") {
          childAlive = false;
        }
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    try {
      const result = await runKnipUnusedFiles({
        closeHandshakeMs: 5,
        killGraceMs: 5,
        platform: "linux",
        spawnCommand: () => child,
        timeoutMs: 5,
        writeStatus: () => {},
      });

      expect(result).toMatchObject({
        errorCode: "ETIMEDOUT",
        signal: null,
        status: null,
      });
      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.unref).toHaveBeenCalledOnce();
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      process.kill = originalKill;
    }
  });

  it("fails closed when Windows process-tree cleanup is indeterminate", async () => {
    const child = new FakeKnipProcess();
    const runTaskkill = vi.fn((_command: string, _args: string[]) => ({
      error: Object.assign(new Error("taskkill timed out"), { code: "ETIMEDOUT" }),
      status: null,
    }));

    const result = await runKnipUnusedFiles({
      platform: "win32",
      runTaskkill,
      spawnCommand: () => child,
      timeoutMs: 5,
      writeStatus: () => {},
    });

    expect(runTaskkill.mock.calls.map(([, args]) => args)).toEqual([["/PID", "12345", "/T", "/F"]]);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.unref).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      errorCode: "EPROCESSGROUP_CLEANUP_FAILED",
      errorMessage: expect.stringMatching(
        /^Knip production unused-file scan timed out after \d+s; Windows process tree cleanup could not be verified$/u,
      ),
      output: "",
      signal: null,
      status: null,
    });
  });

  it.each([
    { errorCode: "ETIMEDOUT", name: "timeout" },
    { errorCode: "ENOBUFS", name: "output cap" },
  ])(
    "force-kills Windows process trees and settles without close after a $name",
    async ({ errorCode, name }) => {
      const child = new FakeKnipProcess();
      const runTaskkill = vi.fn((_command: string, _args: string[]) => ({
        error: undefined,
        status: 0,
      }));
      const statuses: string[] = [];
      const startedAt = Date.now();
      const resultPromise = runKnipUnusedFiles({
        closeHandshakeMs: 5,
        maxBufferBytes: 1,
        platform: "win32",
        runTaskkill,
        spawnCommand: () => child,
        timeoutMs: name === "timeout" ? 5 : 25,
        writeStatus: (message: string) => statuses.push(message),
      });
      if (name === "output cap") {
        child.stdout.emit("data", Buffer.from("xx"));
      }

      await expect(resultPromise).resolves.toMatchObject({
        errorCode,
        signal: null,
        status: null,
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(runTaskkill.mock.calls.map(([, args]) => args)).toEqual([
        ["/PID", "12345", "/T", "/F"],
      ]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);

      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(runTaskkill).toHaveBeenCalledOnce();
      expect(statuses.filter((message) => message.includes("terminating"))).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for timed-out Knip process groups after the wrapper exits",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-timeout-"));
      const childPidPath = path.join(root, "child.pid");
      let childPid = 0;

      try {
        const childScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");

        const resultPromise = runKnipUnusedFiles({
          env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
          killGraceMs: 50,
          spawnCommand(_command: string, _args: string[], options: unknown) {
            return spawn(process.execPath, ["-e", parentScript], {
              ...(options as Parameters<typeof spawn>[2]),
              env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            });
          },
          timeoutMs: 100,
          writeStatus: () => {},
        });

        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(resultPromise).resolves.toMatchObject({
          errorCode: "ETIMEDOUT",
        });
        await waitForDead(childPid, 2_000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans active Knip descendants before forwarding parent SIGTERM",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-parent-signal-"));
      const childPidPath = path.join(root, "child.pid");
      const readyPath = path.join(root, "child.ready");
      const scriptUrl = pathToFileURL(path.resolve("scripts/check-deadcode-unused-files.mjs")).href;
      let childPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;

      try {
        const childScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");
        const runnerScript = [
          "import { spawn } from 'node:child_process';",
          `import { runKnipUnusedFiles } from ${JSON.stringify(scriptUrl)};`,
          "await runKnipUnusedFiles({",
          "  spawnCommand(_command, _args, options) {",
          `    return spawn(process.execPath, ['-e', ${JSON.stringify(parentScript)}], options);`,
          "  },",
          "  timeoutMs: 60_000,",
          "  writeStatus: () => {},",
          "});",
        ].join("\n");

        runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });

        await waitForFile(readyPath, 2_000);
        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForDead(childPid, 2_000);
      } finally {
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "kills timed-out Knip descendants through the resolved pnpm command",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-windows-timeout-"));
      const childPidPath = path.join(root, "child.pid");
      const descendantPidPath = path.join(root, "descendant.pid");
      const pnpmExecPath = path.join(root, "pnpm.cjs");
      const readyPath = path.join(root, "ready");
      const spawnCalls: Array<{
        args: string[];
        command: string;
        options: Parameters<typeof spawn>[2];
      }> = [];
      const statuses: string[] = [];
      let childPid = 0;
      let descendantPid = 0;

      try {
        writeFileSync(
          pnpmExecPath,
          `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(process.pid));
fs.writeFileSync(process.env.OPENCLAW_TEST_DESCENDANT_PID, String(descendant.pid));
fs.writeFileSync(process.env.OPENCLAW_TEST_READY, "ready");
setInterval(() => {}, 1000);
`,
          "utf8",
        );

        const result = await runKnipUnusedFiles({
          env: {
            ...process.env,
            OPENCLAW_TEST_CHILD_PID: childPidPath,
            OPENCLAW_TEST_DESCENDANT_PID: descendantPidPath,
            OPENCLAW_TEST_READY: readyPath,
          },
          nodeExecPath: process.execPath,
          npmExecPath: pnpmExecPath,
          platform: "win32",
          spawnCommand(command: string, args: string[], options: Parameters<typeof spawn>[2]) {
            spawnCalls.push({ args, command, options });
            return spawn(command, args, options);
          },
          timeoutMs: 3_000,
          writeStatus: (message: string) => statuses.push(message),
        });

        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0]).toMatchObject({
          args: [
            pnpmExecPath,
            "--config.minimum-release-age=0",
            "dlx",
            "--package",
            "knip@6.8.0",
            "knip",
            "--config",
            "config/knip.config.ts",
            "--production",
            "--no-progress",
            "--reporter",
            "compact",
            "--files",
            "--no-config-hints",
          ],
          command: process.execPath,
          options: {
            detached: false,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          },
        });
        expect(result).toMatchObject({
          errorCode: "ETIMEDOUT",
          errorMessage: expect.stringContaining("Knip production unused-file scan timed out"),
        });
        expect(statuses).toContain(
          "[deadcode] Knip production unused-file scan timed out after 3s; terminating.",
        );
        await waitForFile(readyPath, 2_000);
        expect(readFileSync(readyPath, "utf8")).toBe("ready");
        childPid = await waitForPidFile(childPidPath, 2_000);
        descendantPid = await waitForPidFile(descendantPidPath, 2_000);
        await waitForDead(childPid, 2_000);
        await waitForDead(descendantPid, 2_000);
      } finally {
        childPid ||= readRecordedPid(childPidPath);
        descendantPid ||= readRecordedPid(descendantPidPath);
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps output delivered after process exit but before stdio close", async () => {
    const child = new FakeKnipProcess();
    const resultPromise = runKnipUnusedFiles({
      spawnCommand: () => child,
      writeStatus: () => {},
    });

    child.stdout.emit("data", "before-exit\n");
    child.emit("exit", 0, null);
    child.stdout.emit("data", "after-exit\n");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: undefined,
      errorMessage: undefined,
      output: "before-exit\nafter-exit\n",
      signal: null,
      status: 0,
    });
  });

  it("bounds captured Knip output", async () => {
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        if (signal === 0) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const resultPromise = runKnipUnusedFiles({
        killGraceMs: 50,
        maxBufferBytes: 4,
        platform: "linux",
        spawnCommand: () => child,
        timeoutMs: 1000,
        writeStatus: () => {},
      });
      child.stdout.emit("data", "too much output");

      await expect(resultPromise).resolves.toStrictEqual({
        errorCode: "ENOBUFS",
        errorMessage: "Knip production unused-file scan exceeded 4 output bytes",
        output: "too ",
        signal: "SIGTERM",
        status: null,
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it("keeps output-cap cleanup exclusive when the timeout would overlap", async () => {
    vi.useFakeTimers();
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    const kills: Array<NodeJS.Signals | number | undefined> = [];
    const statuses: string[] = [];
    let childAlive = true;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        if (signal === 0) {
          if (childAlive) {
            return true;
          }
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        kills.push(signal);
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    try {
      const resultPromise = runKnipUnusedFiles({
        killGraceMs: 40,
        maxBufferBytes: 1,
        platform: "linux",
        spawnCommand: () => child,
        timeoutMs: 20,
        writeStatus: (message: string) => statuses.push(message),
      });
      child.stdout.emit("data", "too much output");
      setTimeout(() => {
        childAlive = false;
        finishFakeProcess(child, 0, null);
      }, 30);

      await vi.advanceTimersByTimeAsync(30);
      await expect(resultPromise).resolves.toStrictEqual({
        errorCode: "ENOBUFS",
        errorMessage: "Knip production unused-file scan exceeded 1 output bytes",
        output: "t",
        signal: null,
        status: 0,
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(statuses).toEqual([
        "[deadcode] Knip production unused-file scan exceeded 1 output bytes; terminating.",
      ]);
      expect(kills).toEqual(["SIGTERM"]);
    } finally {
      process.kill = originalKill;
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails the CLI when a timed-out Knip child exits with status 0",
    () => {
      const result = runKnipCliFixture({
        childSource: `
const fs = require("node:fs");
process.once("SIGTERM", () => {
  fs.writeFileSync(process.env.OPENCLAW_TEST_EXIT_MARKER, "0");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
        preloadSource: `
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, delay === 600_000 ? 250 : delay, ...args);
`,
      });

      expect(result.exitMarker).toBe("0");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[deadcode] Knip command timed out");
      expectSingleFinalFailureTrailer(result.stderr);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails the CLI when an output-capped Knip child exits with status 0",
    () => {
      const result = runKnipCliFixture({
        childSource: `
const fs = require("node:fs");
process.stdout.on("error", () => {});
process.once("SIGTERM", () => {
  fs.writeFileSync(process.env.OPENCLAW_TEST_EXIT_MARKER, "0");
  process.exit(0);
});
process.stdout.write(Buffer.alloc(${KNIP_MAX_BUFFER_BYTES + 1}, "x"));
setInterval(() => {}, 1000);
`,
      });

      expect(result.exitMarker).toBe("0");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[deadcode] Knip command exceeded 16777216 output bytes");
      expectSingleFinalFailureTrailer(result.stderr);
    },
  );

  it("reports spawn errors", async () => {
    const resultPromise = runKnipUnusedFiles({
      spawnCommand: () => {
        const child = new FakeKnipProcess();
        queueMicrotask(() =>
          child.emit(
            "error",
            Object.assign(new Error("spawn pnpm ENOENT"), {
              code: "ENOENT",
            }),
          ),
        );
        return child;
      },
      writeStatus: () => {},
    });

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: "ENOENT",
      errorMessage: "spawn pnpm ENOENT",
      output: "",
      signal: null,
      status: null,
    });
  });
});
