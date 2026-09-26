import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  buildLaunchAgentPlist,
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  quoteLaunchAgentEnvironmentValue,
} from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { readLaunchAgentProgramArguments } from "./launchd-runtime.js";
import {
  resolveLaunchAgentEnvironmentReadOptions,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import {
  buildTaskScript,
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import {
  sanitizeServiceInspectionError,
  ServiceInspectionError,
} from "./service-inspection-error.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
} from "./service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

const native = vi.hoisted(() => ({
  launchctl: vi.fn(),
  scheduler: vi.fn(),
  plutil: vi.fn(),
  plists: new Set<string>(),
}));
vi.mock("./exec-file.js", () => ({ execFileUtf8: native.launchctl }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: native.plutil,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: native.scheduler,
}));

const label = "ai.openclaw.gateway";
const programArguments = ["node", "gateway.js"];
const environment = { HOME: "/service-home", OPENCLAW_STATE_DIR: "/service-state" };
const renderPlist = (args: string[]) => {
  const contents = buildLaunchAgentPlist({
    label,
    programArguments: args,
    stdoutPath: "/service-stdout.log",
    stderrPath: "/service-stderr.log",
    environment,
  });
  native.plists.add(contents);
  return contents;
};
const readers: Array<{
  name: string;
  read: (
    env: GatewayServiceEnv,
    options?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceCommandConfig | null>;
  resolvePath: (env: GatewayServiceEnv) => string;
  render: (args: string[]) => string;
}> = [
  {
    name: "LaunchAgent",
    read: readLaunchAgentProgramArguments,
    resolvePath: resolveLaunchAgentPlistPath,
    render: renderPlist,
  },
  {
    name: "Scheduled Task",
    read: readScheduledTaskCommand,
    resolvePath: resolveTaskScriptPath,
    render: (args) => buildTaskScript({ programArguments: args, environment }),
  },
];

describe("native service command inspection", () => {
  let root: string;
  let env: GatewayServiceEnv;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-command-"));
    env = { HOME: root, USERPROFILE: root, OPENCLAW_LAUNCHD_LABEL: label };
    native.launchctl.mockReset().mockResolvedValue({
      code: 113,
      termination: "exit",
      stdout: "",
      stderr: "Could not find service",
    });
    native.scheduler.mockReset().mockReturnValue({ status: 1, stdout: "-2147024894" });
    native.plists.clear();
    native.plutil.mockReset().mockImplementation(async (_command, args, options) => {
      const captured = Buffer.from(options.input).toString("utf8");
      if (!native.plists.has(captured)) {
        throw new Error("native-plist-inspection-secret-canary");
      }
      return decodeLaunchAgentPlistFixture(options.input, args[1]);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeFile(filename: string, contents: string) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, contents);
  }

  describe.each(readers)("$name", ({ name, read, resolvePath, render }) => {
    it("does not infer absence from a dangling definition link", async () => {
      const filename = resolvePath(env);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.symlink(path.join(root, "absent-definition"), filename, "junction");
      await expect(read(env)).resolves.toBeNull();
      await expect(read(env, { requireEffective: true })).rejects.toThrow(
        `Effective ${name} service command could not be inspected.`,
      );
    });

    it.each(["registered", "unavailable"])(
      "does not infer absence from a missing file when native inspection is %s",
      async (condition) => {
        native.launchctl.mockImplementation(async (_command: string, args: string[]) =>
          args[1]?.startsWith("system/")
            ? { code: 113, termination: "exit", stdout: "", stderr: "Could not find service" }
            : condition === "registered"
              ? { code: 0, termination: "exit", stdout: "state = waiting", stderr: "" }
              : {
                  code: 1,
                  termination: "error",
                  stdout: "",
                  stderr: "native-inspection-secret-canary",
                },
        );
        native.scheduler.mockReturnValue(
          condition === "registered"
            ? { status: 0, stdout: JSON.stringify({ state: 3 }) }
            : { status: 2, stdout: "native-inspection-secret-canary" },
        );
        await expect(read(env)).resolves.toBeNull();
        await expect(read(env, { requireEffective: true })).rejects.toThrow(
          `Effective ${name} service command could not be inspected.`,
        );
      },
    );

    it("keeps missing definitions distinct from failed inspection", async () => {
      await expect(read(env, { requireEffective: true })).resolves.toBeNull();
      await fs.mkdir(resolvePath(env), { recursive: true });
      await expect(read(env)).resolves.toBeNull();
      await expect(read(env, { requireEffective: true })).rejects.toThrow(
        `Effective ${name} service command could not be inspected.`,
      );
    });

    it("rejects an existing definition without an effective command in strict mode", async () => {
      await writeFile(resolvePath(env), render([]));
      await expect(read(env, { requireEffective: true })).rejects.toThrow(
        `Effective ${name} service command could not be inspected.`,
      );
    });

    it("preserves readable recorded paths in both inspection modes", async () => {
      await writeFile(resolvePath(env), render(programArguments));
      for (const requireEffective of [false, true]) {
        await expect(read(env, { requireEffective })).resolves.toMatchObject({
          programArguments,
          environment,
        });
      }
    });
  });

  describe("Windows aggregate Scheduler timeout transport", () => {
    it.each(
      ["parallel", "delegated serial"].flatMap((placement) =>
        ["absent", "ready", "running"].flatMap((condition) =>
          [false, true].map((explicit) => ({ placement, condition, explicit })),
        ),
      ),
    )(
      "preserves $condition with fractional elapsed time ($placement, explicit=$explicit)",
      async ({ placement, condition, explicit }) => {
        mockProcessPlatform("win32");
        const windowsEnv = { ...env, APPDATA: path.join(root, "AppData") };
        const scriptPath = resolveTaskScriptPath(windowsEnv);
        if (condition !== "absent") {
          // No port is recorded: retain Scheduler state without unrelated listener attribution.
          await writeFile(scriptPath, buildTaskScript({ programArguments }));
        }
        let now = 0;
        let firstRead = true;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          if (args[0] === scriptPath && firstRead) {
            firstRead = false;
            now += 100.25;
          }
          return readFile(...args);
        });
        const schedulerAllowances: Array<{ timeout: number | undefined; remaining: number }> = [];
        native.scheduler.mockImplementation(
          (_command: string, args: string[], options?: { timeout?: number }) => {
            const timeout = options?.timeout;
            // Match Node 24.21.0 validateTimeout, not an accept-any-number probe mock.
            if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
              throw Object.assign(new RangeError("timeout must be an unsigned integer"), {
                code: "ERR_OUT_OF_RANGE",
              });
            }
            expect(args).toContain("-EncodedCommand");
            schedulerAllowances.push({ timeout, remaining: 1_000 - now });
            now += 100.25;
            return condition === "absent"
              ? { status: 1, stdout: "-2147024894", stderr: "" }
              : {
                  status: 0,
                  stdout: JSON.stringify({ state: condition === "running" ? 4 : 3, enabled: true }),
                  stderr: "",
                };
          },
        );
        const queryAllowances: Array<{
          timeoutMs: number | undefined;
          noOutputTimeoutMs: number | undefined;
          remaining: number;
        }> = [];
        const run = vi
          .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
          .mockImplementation(async (argv, options) => {
            expect(argv).toEqual(["schtasks", "/Query", "/TN", "OpenClaw Gateway"]);
            if (typeof options === "number") {
              throw new Error("Expected the Scheduler command transport options");
            }
            queryAllowances.push({
              timeoutMs: options.timeoutMs,
              noOutputTimeoutMs: options.noOutputTimeoutMs,
              remaining: 1_000 - now,
            });
            now += 100.25;
            return {
              stdout: "",
              stderr: condition === "absent" ? "missing task" : "",
              code: condition === "absent" ? 1 : 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          });
        const observe = () =>
          readGatewayServiceState(resolveGatewayService(), {
            env: windowsEnv,
            requireEffective: true,
            requireLoadedCommand: true,
            ...(explicit ? { timeoutMs: 1_000 } : {}),
          });
        const { withGatewayServiceUpdateAuthority } = await import("./service-update-authority.js");
        const state =
          placement === "delegated serial"
            ? await withGatewayServiceUpdateAuthority(undefined, observe, {
                updateOwned: false,
                nativeCommand: async () => {
                  throw new Error("Unexpected delegated command");
                },
              })
            : await observe();

        if (condition === "absent") {
          expect(state).toMatchObject({
            command: null,
            installed: false,
            running: false,
            loadState: { status: "not-loaded" },
            runtime: { status: "stopped", missingUnit: true },
          });
        } else {
          expect(state).toMatchObject({
            command: { programArguments },
            installed: true,
            running: condition === "running",
            loadState: { status: "loaded" },
            runtime: {
              status: condition === "running" ? "running" : "stopped",
              state: condition === "running" ? "Running" : "Ready",
            },
          });
          expect(state.runtime?.missingUnit).not.toBe(true);
          expect(state.runtime?.inspectionFailure).toBeUndefined();
        }
        expect(native.scheduler).toHaveBeenCalledTimes(condition === "absent" ? 2 : 1);
        expect(run).toHaveBeenCalledOnce();
        expect(now).toBe(condition === "absent" ? 401 : 300.75);
        for (const allowance of schedulerAllowances) {
          expect(allowance.timeout).toBe(explicit ? Math.floor(allowance.remaining) : 5_000);
          expect(allowance.timeout).toBeGreaterThan(0);
          if (explicit) {
            expect(allowance.timeout).toBeLessThanOrEqual(allowance.remaining);
          }
        }
        for (const allowance of queryAllowances) {
          expect(allowance.timeoutMs).toBe(explicit ? Math.floor(allowance.remaining) : 15_000);
          expect(allowance.noOutputTimeoutMs).toBe(
            explicit ? Math.floor(allowance.remaining) : 30_000,
          );
        }
      },
    );

    it.each(
      ["absent", "installed"].flatMap((condition) =>
        [999.25, 1_000].map((elapsed) => ({ condition, elapsed })),
      ),
    )(
      "does not launch native work with $condition and $elapsed ms already consumed",
      async ({ condition, elapsed }) => {
        mockProcessPlatform("win32");
        const windowsEnv = { ...env, APPDATA: path.join(root, "AppData") };
        const scriptPath = resolveTaskScriptPath(windowsEnv);
        if (condition === "installed") {
          await writeFile(scriptPath, buildTaskScript({ programArguments }));
        }
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          if (args[0] === scriptPath) {
            now = elapsed;
          }
          return readFile(...args);
        });
        // A too-lenient adapter would consume this missing result and manufacture absence.
        native.scheduler.mockReturnValue({ status: 1, stdout: "-2147024894", stderr: "" });
        const run = vi
          .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
          .mockResolvedValue({
            stdout: "",
            stderr: "missing task",
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          });
        const result = readGatewayServiceState(resolveGatewayService(), {
          env: windowsEnv,
          requireEffective: true,
          requireLoadedCommand: true,
          timeoutMs: 1_000,
        });
        if (condition === "absent") {
          await expect(result).rejects.toThrow(
            "Effective Scheduled Task service command could not be inspected.",
          );
        } else if (elapsed === 1_000) {
          await expect(result).rejects.toThrow("Service inspection deadline expired.");
        } else {
          const state = await result;
          expect(state).toMatchObject({
            command: { programArguments },
            installed: true,
            running: false,
            runtime: {
              status: "unknown",
              missingUnit: false,
              inspectionFailure: { detail: "Scheduled Task inspection deadline expired." },
            },
          });
        }
        expect(native.scheduler).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
      },
    );

    it("rejects a late missing Scheduler result after the strict reader deadline", async () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      native.scheduler.mockImplementation(() => {
        now = 1_000;
        return { status: 1, stdout: "-2147024894", stderr: "" };
      });

      await expect(
        readScheduledTaskCommand(env, { requireEffective: true, timeoutMs: 1_000 }),
      ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
      expect(native.scheduler).toHaveBeenCalledOnce();
    });
  });

  it("does not infer Windows service absence while a Startup launcher remains", async () => {
    for (const pathname of resolveStartupEntryPaths(env)) {
      await writeFile(pathname, "@echo off\n");
    }
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow();
  });

  it.each([
    {
      failure: "timeout",
      response: { error: Object.assign(new Error("native-secret-canary"), { code: "ETIMEDOUT" }) },
      diagnostic: { kind: "timeout", timeoutMs: 731 },
      reported: "timed out after 731 ms",
    },
    {
      failure: "spawn",
      response: {
        error: Object.assign(new Error("native-secret-canary"), { code: "EACCES", errno: -13 }),
      },
      diagnostic: { kind: "spawn", errno: -13 },
      reported: "errno -13",
    },
    {
      failure: "lookup access denied",
      response: { status: 1, stdout: "-2147024891", stderr: "native-secret-canary" },
      diagnostic: { kind: "native", exitCode: 1, hresult: -2147024891 },
      reported: "HRESULT 0x80070005",
    },
    {
      failure: "connection missing file",
      response: { status: 2, stdout: "-2147024894", stderr: "native-secret-canary" },
      diagnostic: { kind: "native", exitCode: 2, hresult: -2147024894 },
      reported: "HRESULT 0x80070002",
    },
    {
      failure: "malformed HRESULT",
      response: { status: 1, stdout: "-2147024894 native-secret-canary" },
      diagnostic: { kind: "native", exitCode: 1 },
      reported: "Task Scheduler probe failed (exit 1)",
    },
    {
      failure: "invalid response",
      response: { status: 0, stdout: "native-secret-canary" },
      diagnostic: { kind: "invalid-response" },
      reported: "Task Scheduler probe returned an invalid response",
    },
  ])(
    "preserves safe Windows $failure diagnostics through strict inspection",
    async ({ response, diagnostic, reported }) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      native.scheduler.mockReturnValue(response);
      const error = await readScheduledTaskCommand(env, {
        requireEffective: true,
        timeoutMs: 731,
      }).catch((caughtError: unknown) => caughtError);
      expect(error).toBeInstanceOf(ServiceInspectionError);
      expect(error).toMatchObject({
        reason: "windows-task-inspection-failed",
        message: expect.stringContaining("openclaw gateway status --deep"),
      });
      const sanitized = sanitizeServiceInspectionError(error);
      expect(sanitized.message).toContain("openclaw gateway status --deep");
      expect(sanitized.message).toContain(reported);
      expect(sanitized.cause).toEqual(diagnostic);
      expect(inspect(sanitized)).not.toContain("native-secret-canary");
      expect(JSON.stringify(sanitized.cause)).not.toContain("native-secret-canary");
    },
  );

  it.each([
    "set MALFORMED",
    "set =invalid",
    'set "OPENCLAW_STATE_DIR=%USERPROFILE%\\.openclaw"',
    'set "OPENCLAW_STATE_DIR=%~dp0state"',
    'set "OPENCLAW_STATE_DIR=!USERPROFILE!\\.openclaw"',
    'set "OPENCLAW_STATE_DIR=C:\\literal^^caret"',
    "set OPENCLAW_STATE_DIR=C:\\first & echo second",
    "set /a HOME=1",
    "set /p HOME=prompt",
  ])("rejects an unresolved Windows assignment in strict mode: %s", async (line) => {
    await writeFile(
      resolveTaskScriptPath(env),
      `@echo off\nset HOME=/partial-home\n${line}\nnode gateway.js\n`,
    );
    await expect(readScheduledTaskCommand(env)).resolves.toMatchObject({
      environment: { HOME: "/partial-home" },
    });
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
      "Effective Scheduled Task service command could not be inspected.",
    );
  });

  it("preserves literal Windows assignments without borrowing the caller's environment", async () => {
    await writeFile(
      resolveTaskScriptPath(env),
      [
        "@echo off",
        "set HOME=/literal-home",
        "set home=/effective-home",
        'set "OPENCLAW_STATE_DIR=C:\\literal%%USERPROFILE%% & (state)"',
        'set "NODE_OPTIONS="',
        'set "QUOTED=  literal spaces  "',
        "set UNQUOTED=  literal spaces  ",
        "set PERCENT=%%USERPROFILE%%",
        "node gateway.js",
      ].join("\r\n"),
    );
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).resolves.toMatchObject({
      programArguments,
      environment: {
        HOME: "/effective-home",
        OPENCLAW_STATE_DIR: "C:\\literal%USERPROFILE% & (state)",
        NODE_OPTIONS: "",
        QUOTED: "  literal spaces  ",
        UNQUOTED: "  literal spaces  ",
        PERCENT: "%USERPROFILE%",
      },
    });
  });

  it("rejects a malformed existing plist only in strict mode", async () => {
    await writeFile(resolveLaunchAgentPlistPath(env), "<plist><dict/></plist>");
    await expect(readLaunchAgentProgramArguments(env)).resolves.toBeNull();
    await expect(
      readLaunchAgentProgramArguments(env, { requireEffective: true }),
    ).rejects.toThrow();
  });

  it("rejects a truncated plist even when its command and environment are readable", async () => {
    const truncated = renderPlist(programArguments).replace(/\s*<\/dict>\s*<\/plist>\s*$/, "");
    await writeFile(resolveLaunchAgentPlistPath(env), truncated);
    await expect(readLaunchAgentProgramArguments(env)).resolves.toBeNull();
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });

  it.each([
    { decoded: [] },
    { decoded: { ProgramArguments: "node gateway.js" } },
    { decoded: { ProgramArguments: ["node", 42] } },
    { decoded: { ProgramArguments: programArguments, WorkingDirectory: 42 } },
    { decoded: { ProgramArguments: programArguments, EnvironmentVariables: { HOME: 42 } } },
  ])("rejects unsupported native plist field types: $decoded", async ({ decoded }) => {
    await writeFile(resolveLaunchAgentPlistPath(env), renderPlist(programArguments));
    native.plutil.mockImplementation(async (_command, args, options) =>
      args[1] === "json"
        ? {
            stdout: JSON.stringify(Array.isArray(decoded) ? decoded : { Label: label, ...decoded }),
            stderr: "",
          }
        : decodeLaunchAgentPlistFixture(options.input, args[1]),
    );
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });

  it("preserves the native command without trimming or dropping arguments", async ({
    onTestFinished,
  }) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    onTestFinished(() => clock.mockRestore());
    const recordedArguments = ["node", "  spaced argument  ", ""];
    const contents = renderPlist(recordedArguments);
    await writeFile(resolveLaunchAgentPlistPath(env), contents);
    for (const requireEffective of [false, true]) {
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective, timeoutMs: 750 }),
      ).resolves.toMatchObject({ programArguments: recordedArguments });
    }
    expect(native.plutil).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/plutil",
      ["-convert", "xml1", "-o", "-", "--", "-"],
      expect.objectContaining({ input: Buffer.from(contents), timeoutMs: 750, logOutput: false }),
    );
    expect(native.plutil).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      expect.objectContaining({ input: contents, timeoutMs: 750, logOutput: false }),
    );
  });

  it.each(["missing", "unreadable"])(
    "keeps %s generated environment recovery out of strict inspection",
    async (failure) => {
      const expectedEnvFile = resolveLaunchAgentEnvironmentReadOptions(
        env,
        label,
      ).expectedEnvironmentFilePath;
      const recordedEnvFile = path.join(root, "other", "service-env", `${label}.env`);
      const recordedWrapper = path.join(root, "other", "service-env", `${label}-env-wrapper.sh`);
      await writeFile(expectedEnvFile, "export OPENCLAW_STATE_DIR='/recovered-state'\n");
      if (failure === "unreadable") {
        await fs.mkdir(recordedEnvFile, { recursive: true });
      }
      await writeFile(
        resolveLaunchAgentPlistPath(env),
        renderPlist([
          LAUNCH_AGENT_ENV_WRAPPER_SHELL,
          recordedWrapper,
          recordedEnvFile,
          ...programArguments,
        ]),
      );
      await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject({
        programArguments,
        environment: { OPENCLAW_STATE_DIR: "/recovered-state" },
      });
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective: true }),
      ).rejects.toThrow();
    },
  );

  it.each(["o'brien\\cash$", "first line\r\n  second line\nthird 'quoted' \\cash$"])(
    "reads the recorded generated literal in strict mode: %j",
    async (literal) => {
      const envFile = resolveLaunchAgentEnvironmentReadOptions(
        env,
        label,
      ).expectedEnvironmentFilePath;
      await writeFile(
        envFile,
        `export OPENCLAW_STATE_DIR='/recorded-state'\nexport NODE_OPTIONS=''\nexport QUOTE=${quoteLaunchAgentEnvironmentValue(literal)}\n`,
      );
      await writeFile(
        resolveLaunchAgentPlistPath(env),
        renderPlist([
          LAUNCH_AGENT_ENV_WRAPPER_SHELL,
          resolveLaunchAgentEnvWrapperPath(env, label),
          envFile,
          ...programArguments,
        ]),
      );
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective: true }),
      ).resolves.toMatchObject({
        programArguments,
        environment: { OPENCLAW_STATE_DIR: "/recorded-state", NODE_OPTIONS: "", QUOTE: literal },
      });
    },
  );

  it.each([
    "echo unsupported-command",
    "export OPENCLAW_STATE_DIR='unterminated",
    "export OPENCLAW_STATE_DIR=$(printf unsupported)",
    "export OPENCLAW_STATE_DIR='/partial'; echo unsupported-command",
  ])("rejects unsupported generated environment syntax: %s", async (line) => {
    const envFile = resolveLaunchAgentEnvironmentReadOptions(
      env,
      label,
    ).expectedEnvironmentFilePath;
    await writeFile(envFile, `export HOME='/partial-home'\n${line}\n`);
    await writeFile(
      resolveLaunchAgentPlistPath(env),
      renderPlist([
        LAUNCH_AGENT_ENV_WRAPPER_SHELL,
        resolveLaunchAgentEnvWrapperPath(env, label),
        envFile,
        ...programArguments,
      ]),
    );
    await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject({ programArguments });
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });
});
