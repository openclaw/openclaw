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
    it.each(["dangling", "directory", "empty", "registered", "unavailable"])(
      "keeps a %s definition distinct from proven absence",
      async (condition) => {
        const filename = resolvePath(env);
        if (condition === "directory") {
          await expect(read(env, { requireEffective: true })).resolves.toBeNull();
          await fs.mkdir(filename, { recursive: true });
        } else if (condition === "empty") {
          await writeFile(filename, render([]));
        } else if (condition === "dangling") {
          await fs.mkdir(path.dirname(filename), { recursive: true });
          await fs.symlink(path.join(root, "absent-definition"), filename, "junction");
        } else {
          native.launchctl.mockImplementation(async (_command: string, args: string[]) =>
            args[1]?.startsWith("system/")
              ? { code: 113, termination: "exit", stdout: "", stderr: "Could not find service" }
              : condition === "registered"
                ? {
                    code: 0,
                    termination: "exit",
                    stdout: `${args[1]} = {\n\tstate = waiting\n}`,
                    stderr: "",
                  }
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
        }
        if (condition !== "empty") {
          await expect(read(env)).resolves.toBeNull();
        }
        await expect(read(env, { requireEffective: true })).rejects.toThrow(
          `Effective ${name} service command could not be inspected.`,
        );
      },
    );

    it.each(
      (name === "LaunchAgent"
        ? [programArguments, ["node", "  spaced argument  ", ""]]
        : [programArguments]
      ).map((recordedArguments) => ({ recordedArguments })),
    )(
      "preserves recorded argv %j and environment in both inspection modes",
      async ({ recordedArguments }) => {
        vi.spyOn(performance, "now").mockReturnValue(1_000);
        const contents = render(recordedArguments);
        await writeFile(resolvePath(env), contents);
        for (const requireEffective of [false, true]) {
          await expect(read(env, { requireEffective, timeoutMs: 750 })).resolves.toMatchObject({
            programArguments: recordedArguments,
            environment,
          });
        }
        if (name === "LaunchAgent") {
          expect(native.plutil).toHaveBeenNthCalledWith(
            1,
            "/usr/bin/plutil",
            ["-convert", "xml1", "-o", "-", "--", "-"],
            expect.objectContaining({
              input: Buffer.from(contents),
              timeoutMs: 750,
              logOutput: false,
            }),
          );
          expect(native.plutil).toHaveBeenNthCalledWith(
            2,
            "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", "--", "-"],
            expect.objectContaining({ input: contents, timeoutMs: 750, logOutput: false }),
          );
        }
      },
    );
  });

  describe("Windows aggregate Scheduler timeout transport", () => {
    const registeredTask = (scriptPath: string, state: number) => ({
      status: 0,
      stdout: JSON.stringify({
        taskPath: "\\OpenClaw Gateway",
        state,
        enabled: true,
        actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
      }),
      stderr: "",
    });
    it.each([
      { placement: "parallel", condition: "absent", explicit: false },
      { placement: "parallel", condition: "running", explicit: true },
      { placement: "delegated serial", condition: "absent", explicit: true },
      { placement: "delegated serial", condition: "ready", explicit: false },
    ])(
      "preserves native $condition state with fractional elapsed time ($placement, explicit=$explicit)",
      async ({ placement, condition, explicit }) => {
        mockProcessPlatform("win32");
        const windowsEnv = {
          ...env,
          APPDATA: `C:\\openclaw-test\\${path.basename(root)}\\AppData`,
          OPENCLAW_TASK_SCRIPT: `C:\\openclaw-test\\${path.basename(root)}\\gateway.cmd`,
        };
        const scriptPath = resolveTaskScriptPath(windowsEnv);
        const backingScriptPath = path.join(root, "gateway.cmd");
        if (condition !== "absent") {
          // Native state remains useful even when the command cannot identify its process.
          await writeFile(backingScriptPath, buildTaskScript({ programArguments }));
        }
        let now = 0;
        let firstRead = true;
        const inspectedPath =
          condition === "absent" ? resolveStartupEntryPaths(windowsEnv)[0] : scriptPath;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          if (args[0] === inspectedPath && firstRead) {
            firstRead = false;
            now += 100.25;
          }
          return readFile(args[0] === scriptPath ? backingScriptPath : args[0], args[1]);
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
            expect(args).toContain("-Command");
            expect(args).not.toContain("-EncodedCommand");
            schedulerAllowances.push({ timeout, remaining: 1_000 - now });
            now += 100.25;
            return condition === "absent"
              ? { status: 1, stdout: "-2147024894", stderr: "" }
              : registeredTask(scriptPath, condition === "running" ? 4 : 3);
          },
        );
        const run = vi
          .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
          .mockRejectedValue(new Error("Unexpected legacy Scheduler registration query"));
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
            running: false,
            loadState: { status: "loaded" },
            runtime: {
              status: "unknown",
              state: condition === "running" ? "Running" : "Ready",
            },
          });
          expect(state.runtime?.missingUnit).not.toBe(true);
          expect(state.runtime?.inspectionFailure).toBeUndefined();
        }
        expect(native.scheduler).toHaveBeenCalledTimes(3);
        expect(run).not.toHaveBeenCalled();
        expect(now).toBe(401);
        for (const allowance of schedulerAllowances) {
          expect(allowance.timeout).toBe(explicit ? Math.floor(allowance.remaining) : 60_000);
          expect(allowance.timeout).toBeGreaterThan(0);
          if (explicit) {
            expect(allowance.timeout).toBeLessThanOrEqual(allowance.remaining);
          }
        }
      },
    );

    it.each([{ condition: "installed", elapsed: 1_000 }])(
      "does not launch further native work after reading $condition consumes $elapsed ms",
      async ({ condition, elapsed }) => {
        mockProcessPlatform("win32");
        const windowsEnv = {
          ...env,
          APPDATA: `C:\\openclaw-test\\${path.basename(root)}\\AppData`,
          OPENCLAW_TASK_SCRIPT: `C:\\openclaw-test\\${path.basename(root)}\\gateway.cmd`,
        };
        const scriptPath = resolveTaskScriptPath(windowsEnv);
        const backingScriptPath = path.join(root, "gateway.cmd");
        if (condition === "installed") {
          await writeFile(backingScriptPath, buildTaskScript({ programArguments }));
        }
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const inspectedPath =
          condition === "absent" ? resolveStartupEntryPaths(windowsEnv)[0] : scriptPath;
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          if (args[0] === inspectedPath) {
            now = elapsed;
          }
          return readFile(args[0] === scriptPath ? backingScriptPath : args[0], args[1]);
        });
        // Registration is inspected first; the later launcher read consumes its remaining budget.
        native.scheduler.mockReturnValue(
          condition === "absent"
            ? { status: 1, stdout: "-2147024894", stderr: "" }
            : registeredTask(scriptPath, 3),
        );
        const run = vi
          .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
          .mockRejectedValue(new Error("Unexpected legacy Scheduler registration query"));
        const result = readGatewayServiceState(resolveGatewayService(), {
          env: windowsEnv,
          requireEffective: true,
          requireLoadedCommand: true,
          timeoutMs: 1_000,
        });
        await expect(result).rejects.toMatchObject({
          reason: "windows-task-inspection-failed",
          cause: { kind: "timeout", timeoutMs: 0 },
        });
        expect(native.scheduler).toHaveBeenCalledOnce();
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
      failure: "spawn without a resolvable Startup home",
      missingStartupHome: true,
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
      reported: "Task Scheduler check failed (exit 1)",
    },
    {
      failure: "invalid response",
      response: { status: 0, stdout: "native-secret-canary" },
      diagnostic: { kind: "invalid-response" },
      reported: "Task Scheduler check returned an invalid response",
    },
  ])(
    "preserves safe Windows $failure diagnostics through strict inspection",
    async ({ response, diagnostic, reported, missingStartupHome = false }) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      native.scheduler.mockReturnValue(response);
      const inspectionEnv = missingStartupHome
        ? { OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(env) }
        : env;
      const error = await readScheduledTaskCommand(inspectionEnv, {
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

  const assignments: Array<{
    name: string;
    lines: string[];
    environment?: Record<string, string>;
  }> = [
    ...[
      "set MALFORMED",
      "set =invalid",
      'set "OPENCLAW_STATE_DIR=%USERPROFILE%\\.openclaw"',
      'set "OPENCLAW_STATE_DIR=%~dp0state"',
      'set "OPENCLAW_STATE_DIR=!USERPROFILE!\\.openclaw"',
      'set "OPENCLAW_STATE_DIR=C:\\literal^^caret"',
      "set OPENCLAW_STATE_DIR=C:\\first & echo second",
      "set /a HOME=1",
      "set /p HOME=prompt",
    ].map((line) => ({
      name: line,
      lines: ["@echo off", "set HOME=/partial-home", line, "node gateway.js"],
    })),
    {
      name: "literal assignments",
      lines: [
        "@echo off",
        "set HOME=/literal-home",
        "set home=/effective-home",
        'set "OPENCLAW_STATE_DIR=C:\\literal%%USERPROFILE%% & (state)"',
        'set "NODE_OPTIONS="',
        'set "QUOTED=  literal spaces  "',
        "set UNQUOTED=  literal spaces  ",
        "set PERCENT=%%USERPROFILE%%",
        "node gateway.js",
      ],
      environment: {
        HOME: "/effective-home",
        OPENCLAW_STATE_DIR: "C:\\literal%USERPROFILE% & (state)",
        NODE_OPTIONS: "",
        QUOTED: "  literal spaces  ",
        UNQUOTED: "  literal spaces  ",
        PERCENT: "%USERPROFILE%",
      },
    },
  ];
  it.each(assignments)(
    "reads Windows environment literally: $name",
    async ({ lines, environment: expectedEnvironment }) => {
      await writeFile(resolveTaskScriptPath(env), lines.join("\r\n"));
      if (expectedEnvironment) {
        await expect(
          readScheduledTaskCommand(env, { requireEffective: true }),
        ).resolves.toMatchObject({ programArguments, environment: expectedEnvironment });
      } else {
        await expect(readScheduledTaskCommand(env)).resolves.toMatchObject({
          environment: { HOME: "/partial-home" },
        });
        await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
          "Effective Scheduled Task service command could not be inspected.",
        );
      }
    },
  );

  it.each([
    { content: "malformed" },
    { content: "truncated" },
    { decoded: [] },
    { decoded: { ProgramArguments: "node gateway.js" } },
    { decoded: { ProgramArguments: ["node", 42] } },
    { decoded: { ProgramArguments: programArguments, WorkingDirectory: 42 } },
    { decoded: { ProgramArguments: programArguments, EnvironmentVariables: { HOME: 42 } } },
  ])("rejects unreadable native plist contents or fields: %j", async ({ decoded, content }) => {
    await writeFile(
      resolveLaunchAgentPlistPath(env),
      content === "malformed"
        ? "<plist><dict/></plist>"
        : content === "truncated"
          ? renderPlist(programArguments).replace(/\s*<\/dict>\s*<\/plist>\s*$/, "")
          : renderPlist(programArguments),
    );
    if (content) {
      await expect(readLaunchAgentProgramArguments(env)).resolves.toBeNull();
    } else {
      native.plutil.mockImplementation(async (_command, args, options) =>
        args[1] === "json"
          ? {
              stdout: JSON.stringify(
                Array.isArray(decoded) ? decoded : { Label: label, ...decoded },
              ),
              stderr: "",
            }
          : decodeLaunchAgentPlistFixture(options.input, args[1]),
      );
    }
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });

  it.each([
    "missing",
    "unreadable",
    "literal",
    "echo unsupported-command",
    "export OPENCLAW_STATE_DIR='unterminated",
    "export OPENCLAW_STATE_DIR=$(printf unsupported)",
    "export OPENCLAW_STATE_DIR='/partial'; echo unsupported-command",
  ])("inspects generated environment without inventing effective values: %s", async (scenario) => {
    const recovering = scenario === "missing" || scenario === "unreadable";
    const expectedEnvFile = resolveLaunchAgentEnvironmentReadOptions(
      env,
      label,
    ).expectedEnvironmentFilePath;
    const envFile = recovering
      ? path.join(root, "other", "service-env", `${label}.env`)
      : expectedEnvFile;
    const wrapper = recovering
      ? path.join(root, "other", "service-env", `${label}-env-wrapper.sh`)
      : resolveLaunchAgentEnvWrapperPath(env, label);
    const literal = "first line\r\n  second line\nthird 'quoted' \\cash$";
    await writeFile(
      expectedEnvFile,
      recovering
        ? "export OPENCLAW_STATE_DIR='/recovered-state'\n"
        : scenario === "literal"
          ? `export OPENCLAW_STATE_DIR='/recorded-state'\nexport NODE_OPTIONS=''\nexport QUOTE=${quoteLaunchAgentEnvironmentValue(literal)}\n`
          : `export HOME='/partial-home'\n${scenario}\n`,
    );
    if (scenario === "unreadable") {
      await fs.mkdir(envFile, { recursive: true });
    }
    await writeFile(
      resolveLaunchAgentPlistPath(env),
      renderPlist([LAUNCH_AGENT_ENV_WRAPPER_SHELL, wrapper, envFile, ...programArguments]),
    );
    if (scenario === "literal") {
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective: true }),
      ).resolves.toMatchObject({
        programArguments,
        environment: { OPENCLAW_STATE_DIR: "/recorded-state", NODE_OPTIONS: "", QUOTE: literal },
      });
    } else {
      await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject({
        programArguments,
        ...(recovering ? { environment: { OPENCLAW_STATE_DIR: "/recovered-state" } } : {}),
      });
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective: true }),
      ).rejects.toThrow("Effective LaunchAgent service command could not be inspected.");
    }
  });
});
