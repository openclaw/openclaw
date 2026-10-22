import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as currentService from "./launchd-current-service.js";
import { restartLaunchAgent } from "./launchd-lifecycle.js";
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
import * as ownership from "./launchd-system.js";
import {
  buildTaskScript,
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import {
  sanitizeServiceInspectionError,
  ServiceInspectionError,
  type ServiceInspectionDiagnostic,
} from "./service-inspection-error.js";
import type { GatewayServiceEnv, GatewayServiceReadOptions } from "./service-types.js";
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
const launchResult = (stdout = "", code = 0, termination = "exit", stderr = "") => ({
  code,
  termination,
  stdout,
  stderr,
});
const missingJob = launchResult("", 113, "exit", "Could not find service");
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
const renderTask = (args: string[]) => buildTaskScript({ programArguments: args, environment });
const readers = [
  ["LaunchAgent", readLaunchAgentProgramArguments, resolveLaunchAgentPlistPath, renderPlist],
  ["Scheduled Task", readScheduledTaskCommand, resolveTaskScriptPath, renderTask],
] as const;
const nativeError = (code: string, errno?: number) => ({
  error: Object.assign(new Error("native-secret-canary"), { code, errno }),
});
const nativeFailure = (status: number, stdout: string) => ({
  status,
  stdout,
  stderr: "native-secret-canary",
});

describe("native service command inspection", () => {
  let root: string;
  let env: GatewayServiceEnv;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-command-"));
    env = { HOME: root, USERPROFILE: root, OPENCLAW_LAUNCHD_LABEL: label };
    native.launchctl.mockReset().mockResolvedValue(missingJob);
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

  it("preserves nested native cleanup while proving a missing plist is absent", async () => {
    const failure = new AggregateError(
      [new CommandProcessCleanupError()],
      "native inspection failed",
    );
    native.launchctl.mockImplementation(async (_command: string, args: string[]) => {
      if (args.some((arg) => arg.startsWith("gui/"))) {
        throw failure;
      }
      return missingJob;
    });

    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toBe(
      failure,
    );
  });

  it("stops restart when the plist reader cannot confirm native cleanup", async () => {
    const failure = new CommandProcessCleanupError();
    await writeFile(resolveLaunchAgentPlistPath(env), renderPlist(programArguments));
    native.plutil.mockRejectedValue(failure);
    vi.spyOn(currentService, "isCurrentProcessInsideLaunchdService").mockResolvedValue(false);
    vi.spyOn(ownership, "assertNoSystemLaunchDaemonOwnership").mockResolvedValue();
    const stdout = new PassThrough();
    const onMutation = vi.fn();

    await expect(
      restartLaunchAgent({ env, stdout, onMutation, preserveDefinition: true }),
    ).rejects.toBe(failure);
    expect(native.launchctl).not.toHaveBeenCalled();
    expect(onMutation).not.toHaveBeenCalled();
    expect(stdout.read()).toBeNull();
  });

  const strictTask = (options: GatewayServiceReadOptions = {}) =>
    readScheduledTaskCommand(env, { requireEffective: true, ...options });
  const strictPlist = () => readLaunchAgentProgramArguments(env, { requireEffective: true });
  const unreadable = (name: string) => `Effective ${name} service command could not be inspected.`;

  describe.each(readers)("%s", (name, read, resolvePath, render) => {
    it.each(["dangling", "directory", "empty", "registered", "unavailable"])(
      "does not treat %s definitions as absent",
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
          native.launchctl.mockImplementation(async (_command: string, args: string[]) => {
            if (args[1]?.startsWith("system/")) {
              return missingJob;
            }
            return condition === "registered"
              ? launchResult(`${args[1]} = {\n\tstate = waiting\n}`)
              : launchResult("", 1, "error", "native-inspection-secret-canary");
          });
          native.scheduler.mockReturnValue(
            condition === "registered"
              ? { status: 0, stdout: JSON.stringify({ state: 3 }) }
              : { status: 2, stdout: "native-inspection-secret-canary" },
          );
        }
        if (condition !== "empty") {
          await expect(read(env)).resolves.toBeNull();
        }
        await expect(read(env, { requireEffective: true })).rejects.toThrow(unreadable(name));
      },
    );
  });

  describe("Windows aggregate Scheduler timeout transport", () => {
    async function windowsFixture(
      present: boolean,
      onRead: () => void,
      content = buildTaskScript({ programArguments }),
    ) {
      mockProcessPlatform("win32");
      const windowsEnv = {
        ...env,
        APPDATA: `C:\\openclaw-test\\${path.basename(root)}\\AppData`,
        OPENCLAW_TASK_SCRIPT: `C:\\openclaw-test\\${path.basename(root)}\\gateway.cmd`,
      };
      const scriptPath = resolveTaskScriptPath(windowsEnv);
      const backingScriptPath = path.join(root, "gateway.cmd");
      if (present) {
        await writeFile(backingScriptPath, content);
      }
      const inspectedPath = present ? scriptPath : resolveStartupEntryPaths(windowsEnv)[0];
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === inspectedPath) {
          onRead();
        }
        return readFile(args[0] === scriptPath ? backingScriptPath : args[0], args[1]);
      });
      const run = vi
        .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
        .mockRejectedValue(new Error("Unexpected legacy Scheduler registration query"));
      const observe = (timeoutMs?: number) =>
        readGatewayServiceState(resolveGatewayService(), {
          env: windowsEnv,
          requireEffective: true,
          requireLoadedCommand: true,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      return { scriptPath, run, observe, windowsEnv };
    }
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
      ['set "TOKEN=%launcher-secret-canary%"', 4, "invalid environment assignment"],
      ['node "%launcher-secret-canary%"', 4, "dynamic command"],
      ["node gateway.js & echo launcher-secret-canary", 4, "ambiguous command"],
      ['cd /d "C:\\launcher-secret-canary" extra', 4, "ambiguous working directory"],
      ["node gateway.js\r\necho launcher-secret-canary", 5, "multiple commands"],
    ] as const)("preserves safe physical-line diagnostics for %s", async (body, line, reason) => {
      const content = `@echo off\r\n\r\nrem fixture header\r\n${body}\r\n`;
      const { scriptPath, observe, windowsEnv } = await windowsFixture(
        true,
        () => undefined,
        content,
      );
      native.scheduler.mockReturnValue(registeredTask(scriptPath, 3));
      const detail = `Launcher line ${line}: ${reason}.`;
      const state = await readGatewayServiceState(resolveGatewayService(), { env: windowsEnv });
      expect(state).toMatchObject({
        command: null,
        runtime: {
          status: "unknown",
          inspectionFailure: {
            code: "service-runtime-inspection-failed",
            detail: expect.stringContaining(detail),
          },
        },
      });
      const error = await observe().catch((caughtError: unknown) => caughtError);
      expect(sanitizeServiceInspectionError(error).message).toContain(detail);
      expect(state.runtime?.inspectionFailure?.detail).toContain("Review the launcher");
      expect(inspect({ state, error })).not.toContain("launcher-secret-canary");
      expect(await fs.readFile(path.join(root, "gateway.cmd"), "utf8")).toBe(content);
    });
    it.each([
      ["parallel", "absent", false, false],
      ["parallel", "running", true, false],
      ["delegated serial", "absent", true, false],
      ["delegated serial", "ready", false, false],
      ["parallel", "ready", true, true],
    ] as const)(
      "%s preserves %s state (explicit=%s, expired=%s)",
      async (placement, condition, explicit, expired) => {
        let now = 0;
        let firstRead = true;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const { scriptPath, run, observe } = await windowsFixture(condition !== "absent", () => {
          if (firstRead) {
            firstRead = false;
            now += expired ? 1_000 : 100.25;
          }
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
            now += expired ? 0 : 100.25;
            return condition === "absent"
              ? { status: 1, stdout: "-2147024894", stderr: "" }
              : registeredTask(scriptPath, condition === "running" ? 4 : 3);
          },
        );
        const readState = () => observe(explicit ? 1_000 : undefined);
        const { withGatewayServiceUpdateAuthority } = await import("./service-update-authority.js");
        const result =
          placement === "delegated serial"
            ? withGatewayServiceUpdateAuthority(undefined, readState, {
                updateOwned: false,
                nativeCommand: async () => {
                  throw new Error("Unexpected delegated command");
                },
              })
            : readState();
        if (expired) {
          await expect(result).rejects.toMatchObject({
            reason: "windows-task-inspection-failed",
            cause: { kind: "timeout", timeoutMs: 0 },
          });
          expect(native.scheduler).toHaveBeenCalledOnce();
          expect(run).not.toHaveBeenCalled();
          return;
        }
        const state = await result;

        const absent = condition === "absent";
        expect(state).toMatchObject({
          command: absent ? null : { programArguments },
          installed: !absent,
          running: false,
          loadState: { status: absent ? "not-loaded" : "loaded" },
          runtime: absent
            ? { status: "stopped", missingUnit: true }
            : {
                status: "unknown",
                state: condition === "running" ? "Running" : "Ready",
              },
        });
        if (!absent) {
          expect(state.runtime?.missingUnit).not.toBe(true);
          expect(state.runtime?.inspectionFailure).toBeUndefined();
        }
        expect(native.scheduler).toHaveBeenCalledTimes(3);
        expect(run).not.toHaveBeenCalled();
        expect(now).toBe(401);
        expect(schedulerAllowances.map(({ timeout }) => timeout)).toEqual(
          schedulerAllowances.map(({ remaining }) => (explicit ? Math.floor(remaining) : 60_000)),
        );
      },
    );

    it("rejects late Scheduler absence", async () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      native.scheduler.mockImplementation(() => {
        now = 1_000;
        return { status: 1, stdout: "-2147024894", stderr: "" };
      });

      await expect(strictTask({ timeoutMs: 1_000 })).rejects.toThrow(unreadable("Scheduled Task"));
      expect(native.scheduler).toHaveBeenCalledOnce();
    });
  });

  it("does not treat a Startup launcher as absent", async () => {
    for (const pathname of resolveStartupEntryPaths(env)) {
      await writeFile(pathname, "@echo off\n");
    }
    await expect(strictTask()).rejects.toThrow();
  });

  it.each([
    [nativeError("ETIMEDOUT"), { kind: "timeout", timeoutMs: 731 }, "timed out after 731 ms"],
    [nativeError("EACCES", -13), { kind: "spawn", errno: -13 }, "errno -13"],
    [nativeError("EACCES", -13), { kind: "spawn", errno: -13 }, "errno -13", true],
    [
      nativeFailure(1, "-2147024891"),
      { kind: "native", exitCode: 1, hresult: -2147024891 },
      "HRESULT 0x80070005",
    ],
    [
      nativeFailure(2, "-2147024894"),
      { kind: "native", exitCode: 2, hresult: -2147024894 },
      "HRESULT 0x80070002",
    ],
    [
      nativeFailure(1, "-2147024894 native-secret-canary"),
      { kind: "native", exitCode: 1 },
      "Task Scheduler check failed (exit 1)",
    ],
    [
      { status: 0, stdout: "native-secret-canary" },
      { kind: "invalid-response" },
      "Task Scheduler check returned an invalid response",
    ],
  ] satisfies Array<[object, ServiceInspectionDiagnostic, string, boolean?]>)(
    "preserves safe Scheduler diagnostics: %j",
    async (response, diagnostic, reported, missingStartupHome?: boolean) => {
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
      expect(error).toMatchObject({ reason: "windows-task-inspection-failed" });
      const sanitized = sanitizeServiceInspectionError(error);
      expect(sanitized.message).toContain("openclaw gateway status --deep");
      expect(sanitized.message).toContain(reported);
      expect(sanitized.cause).toEqual(diagnostic);
      expect(inspect(sanitized)).not.toContain("native-secret-canary");
    },
  );

  const assignments: Array<[string[], Record<string, string>?]> = [
    ...[
      "set MALFORMED",
      'set "OPENCLAW_STATE_DIR=%USERPROFILE%\\.openclaw"',
      'set "OPENCLAW_STATE_DIR=!USERPROFILE!\\.openclaw"',
      'set "OPENCLAW_STATE_DIR=C:\\literal^^caret"',
      "set OPENCLAW_STATE_DIR=C:\\first & echo second",
      "set /a HOME=1",
    ].map((line): [string[]] => [["@echo off", "set HOME=/partial-home", line, "node gateway.js"]]),
    [
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
      ],
      {
        HOME: "/effective-home",
        OPENCLAW_STATE_DIR: "C:\\literal%USERPROFILE% & (state)",
        NODE_OPTIONS: "",
        QUOTED: "  literal spaces  ",
        UNQUOTED: "  literal spaces  ",
        PERCENT: "%USERPROFILE%",
      },
    ],
  ];
  it.each(assignments)(
    "reads Windows environment literally: %j",
    async (lines, expectedEnvironment) => {
      await writeFile(resolveTaskScriptPath(env), lines.join("\r\n"));
      if (expectedEnvironment) {
        await expect(strictTask()).resolves.toMatchObject({
          programArguments,
          environment: expectedEnvironment,
        });
      } else {
        await expect(readScheduledTaskCommand(env)).resolves.toMatchObject({
          environment: { HOME: "/partial-home" },
        });
        await expect(strictTask()).rejects.toThrow(unreadable("Scheduled Task"));
      }
    },
  );

  it.each([
    { content: "truncated" },
    { decoded: [] },
    { decoded: { ProgramArguments: "node gateway.js" } },
    { decoded: { ProgramArguments: ["node", 42] } },
    { decoded: { ProgramArguments: programArguments, WorkingDirectory: 42 } },
    { decoded: { ProgramArguments: programArguments, EnvironmentVariables: { HOME: 42 } } },
  ])("rejects malformed plists: %j", async ({ decoded, content }) => {
    await writeFile(
      resolveLaunchAgentPlistPath(env),
      content === "truncated"
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
    await expect(strictPlist()).rejects.toThrow(unreadable("LaunchAgent"));
  });

  it.each([
    "missing",
    "unreadable",
    "literal",
    "echo unsupported-command",
    "export OPENCLAW_STATE_DIR='unterminated",
    "export OPENCLAW_STATE_DIR=$(printf unsupported)",
  ])("inspects generated environment: %s", async (scenario) => {
    const recovering = scenario === "missing" || scenario === "unreadable";
    const expectedEnvFile = resolveLaunchAgentEnvironmentReadOptions(
      env,
      label,
    ).expectedEnvironmentFilePath;
    const other = path.join(root, "other", "service-env", label);
    const envFile = recovering ? `${other}.env` : expectedEnvFile;
    const wrapper = recovering
      ? `${other}-env-wrapper.sh`
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
    const expected =
      scenario === "literal"
        ? {
            environment: {
              OPENCLAW_STATE_DIR: "/recorded-state",
              NODE_OPTIONS: "",
              QUOTE: literal,
            },
          }
        : recovering
          ? { environment: { OPENCLAW_STATE_DIR: "/recovered-state" } }
          : {};
    await expect(
      scenario === "literal" ? strictPlist() : readLaunchAgentProgramArguments(env),
    ).resolves.toMatchObject({ programArguments, ...expected });
    if (scenario !== "literal") {
      await expect(strictPlist()).rejects.toThrow(unreadable("LaunchAgent"));
    }
  });
});
