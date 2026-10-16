import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it as base, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import {
  installScheduledTask,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
  stageScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import { buildServiceEnvironment } from "./service-env.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const taskProbe = vi.hoisted(() =>
  vi.fn(() => ({ status: 0, stdout: '{"state":4,"enabled":true}', stderr: "" })),
);

// Install tests control registration separately; runtime probes never inspect host tasks.
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: taskProbe,
}));

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

// Pin code page detection so launcher encoding never depends on the host ACP.
vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

const schtasksCalls: string[][] = [];
const schtasksResponses: { code: number; stdout: string; stderr: string }[] = [];
let registrationResponse: (typeof schtasksResponses)[number] | undefined;
let registrationChanged = false;
let registeredXml: string | undefined;
vi.mock("./schtasks-control.js", async (original) => ({
  ...(await original<typeof import("./schtasks-control.js")>()),
  stopRegisteredScheduledTask: async () => false,
}));
// Capture XML before production cleanup, indexed by its /Create call.
const xmlPayloadCaptures: Array<{ index: number; xml: string }> = [];

// mock-isolation: Registration and mutation responses belong to the synthetic Task Scheduler.
vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    const index = schtasksCalls.length;
    schtasksCalls.push(argv);
    const xmlFlagPos = argv.indexOf("/XML");
    const xmlPath = xmlFlagPos === -1 ? undefined : argv[xmlFlagPos + 1];
    if (xmlPath !== undefined) {
      try {
        const raw = await fs.readFile(xmlPath);
        // Strip the UTF-16 LE BOM and decode for readable assertions.
        xmlPayloadCaptures.push({ index, xml: raw.slice(2).toString("utf16le") });
      } catch {
        // Mock cannot block production cleanup; tests assert via captured payloads.
      }
    }
    const querying = argv[0] === "/Query" && argv.includes("/XML");
    const response =
      querying && registrationResponse && !registrationChanged
        ? registrationResponse
        : (schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" });
    if (argv[0] === "/Create") {
      registrationChanged = true;
      if (response.code === 0) {
        registeredXml = xmlPayloadCaptures.at(-1)?.xml;
      }
    }
    if (querying) {
      registrationResponse = response;
      registrationChanged = false;
    }
    if (querying && response.code !== 0 && response.stderr.includes("cannot find the file")) {
      taskProbe.mockReturnValueOnce({ status: 1, stdout: "-2147024894", stderr: "" });
    }
    return querying && response.code === 0 && !response.stdout
      ? {
          ...response,
          stdout:
            registeredXml ??
            "<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>gateway.cmd</Command></Exec></Actions></Task>",
        }
      : response;
  },
}));

beforeEach(() => {
  schtasksCalls.length = 0;
  schtasksResponses.length = 0;
  registrationResponse = undefined;
  registrationChanged = false;
  registeredXml = undefined;
  xmlPayloadCaptures.length = 0;
  taskProbe
    .mockReset()
    .mockReturnValue({ status: 0, stdout: '{"state":4,"enabled":true}', stderr: "" });
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
});

describe("installScheduledTask", () => {
  const okSchtasksResponse = { code: 0, stdout: "", stderr: "" };
  const accessDeniedResponse = { code: 1, stdout: "", stderr: "ERROR: Access is denied." };
  const missingTaskResponse = {
    code: 1,
    stdout: "",
    stderr: "ERROR: The system cannot find the file specified.",
  };

  const it = base.extend<{ env: { USERPROFILE: string; OPENCLAW_PROFILE: string } }>({
    env: async ({ task: _task }, use) => {
      await use({
        USERPROFILE: temporary.make("openclaw-schtasks-install-"),
        OPENCLAW_PROFILE: "default",
      });
    },
  });

  function installDefaultGatewayTask(
    env: Record<string, string>,
    overrides: Partial<Parameters<typeof installScheduledTask>[0]> = {},
  ) {
    return installScheduledTask({
      env,
      stdout: new PassThrough(),
      programArguments: ["node", "gateway.js"],
      environment: {},
      ...overrides,
    });
  }

  function expectContains(text: string | undefined, included: string[], excluded: string[] = []) {
    for (const value of included) {
      expect(text).toContain(value);
    }
    for (const value of excluded) {
      expect(text).not.toContain(value);
    }
  }

  function expectInitialTaskQuery(taskName = "OpenClaw Gateway"): void {
    expect(schtasksCalls[0]).toEqual(["/Query", "/TN", taskName, "/XML"]);
  }

  function expectTaskRunCall(index: number, taskName = "OpenClaw Gateway"): void {
    expect(schtasksCalls[index]).toEqual(["/Run", "/TN", taskName]);
  }
  function expectCallSequence(sequence: string) {
    expect(schtasksCalls.map((call) => call[0])).toEqual(sequence.split(" "));
  }
  function expectTaskCreateCall(index: number, taskName = "OpenClaw Gateway") {
    expect(schtasksCalls[index]?.slice(0, 5)).toEqual(["/Create", "/F", "/TN", taskName, "/XML"]);
    expect(schtasksCalls[index]).not.toContain("/RU");
    expect(schtasksCalls[index]).not.toContain("/NP");
  }
  async function readScript(scriptPath: string) {
    return decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
  }

  it("stages a noninteractive launcher without registering a task (#112173)", async ({ env }) => {
    const { scriptPath } = await stageScheduledTask({
      env,
      stdout: new PassThrough(),
      programArguments: ["node", "gateway.js"],
      environment: {},
    });
    expect(schtasksCalls).toEqual([]);
    const script = await readScript(scriptPath);
    expect(script).toContain("node gateway.js < NUL");

    await expect(readScheduledTaskCommand(env)).resolves.toStrictEqual({
      programArguments: ["node", "gateway.js"],
      sourcePath: scriptPath,
    });
  });

  it("writes quoted set assignments and escapes metacharacters", async ({ env }) => {
    const assignments = [
      ["OC_INJECT", "safe & whoami | calc", 'set "OC_INJECT=safe & whoami | calc"'],
      ["OC_CARET", "a^b", 'set "OC_CARET=a^^b"'],
      ["OC_PERCENT", "%TEMP%", 'set "OC_PERCENT=%%TEMP%%"'],
      ["OC_BANG", "!token!", 'set "OC_BANG=^!token^!"'],
      [
        "OC_SOURCE_PATH",
        "C:\\OpenClaw source & ^ %USERPROFILE%!",
        'set "OC_SOURCE_PATH=C:\\OpenClaw source & ^^ %%USERPROFILE%%^!"',
      ],
      ["OC_QUOTE", 'he said "hi"', 'set "OC_QUOTE=he said ^"hi^""'],
      ["NODE_OPTIONS", "", 'set "NODE_OPTIONS="'],
    ] satisfies [string, string, string][];
    const inline = Object.fromEntries(assignments.map(([key, value]) => [key, value]));
    const programArguments = [
      ["node", "gateway.js"],
      ["--display-name", "safe&whoami"],
      ["--percent", "%TEMP%"],
      ["--bang", "!token!"],
    ].flat();
    const { scriptPath } = await installDefaultGatewayTask(env, {
      programArguments: [...programArguments],
      workingDirectory: "C:\\temp\\poc&calc",
      description: "OpenClaw fixture",
      environment: {
        ...inline,
        OC_EMPTY: "",
        PATH: "C:\\Windows\\System32",
      },
    });

    const script = await readScript(scriptPath);
    expectContains(
      script,
      [
        'cd /d "C:\\temp\\poc&calc"',
        'node gateway.js --display-name "safe&whoami" --percent "%%TEMP%%" --bang "^!token^!"',
        ...assignments.map((assignment) => assignment[2]),
        "rem OpenClaw fixture",
      ],
      ['set "OC_EMPTY=', "set OC_INJECT=", 'set "PATH='],
    );

    const parsed = await readScheduledTaskCommand(env);
    expect(parsed).toStrictEqual({
      programArguments,
      workingDirectory: "C:\\temp\\poc&calc",
      environment: inline,
      environmentValueSources: Object.fromEntries(assignments.map(([key]) => [key, "inline"])),
      sourcePath: scriptPath,
    });

    expect(schtasksCalls[0]).toEqual(["/Query", "/TN", "OpenClaw Gateway", "/XML"]);
    expect(schtasksCalls[3]?.[0]).toBe("/Change");
    // Battery-flag XML re-apply runs between /Change and /Run on upgrades.
    expectTaskCreateCall(4);
    expect(schtasksCalls[6]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
  });

  it("rejects line breaks in command arguments, env vars, and descriptions", async ({ env }) => {
    const cases = [
      {
        options: { programArguments: ["node", "gateway.js", "bad\narg"] },
        field: "Command argument",
      },
      { options: { environment: { BAD: "line1\r\nline2" } }, field: "Environment variable value" },
      { options: { description: "bad\ndescription" }, field: "Task description" },
    ];
    for (const { options, field } of cases) {
      await expect(installDefaultGatewayTask(env, options)).rejects.toThrow(
        `${field} cannot contain CR or LF`,
      );
    }
  });

  it("keeps the requested desktop launcher for node hosts", async ({ env }) => {
    schtasksResponses.push(okSchtasksResponse);
    const { scriptPath } = await installDefaultGatewayTask({
      ...env,
      USERPROFILE: path.join(env.USERPROFILE, "苗振"),
      USERDOMAIN: "WORKSTATION",
      USERNAME: "alice",
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "true",
      OPENCLAW_SERVICE_KIND: "node",
    });
    const launcherPath = scriptPath.replace(/\.cmd$/i, ".vbs");
    const rawLauncher = await fs.readFile(launcherPath);
    const launcher = decodeWindowsLauncherScript({ buffer: rawLauncher });

    expect(scriptPath).toContain("苗振");
    expectInitialTaskQuery();
    expect(schtasksCalls[3]).toEqual([
      "/Change",
      "/TN",
      "OpenClaw Gateway",
      "/TR",
      expect.stringContaining("gateway.vbs"),
    ]);
    expect(schtasksCalls[3]?.[4]).toContain(launcherPath);
    // wscript requires a BOM for UTF-16; XML owns the interactive principal.
    expect(rawLauncher.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expectTaskCreateCall(4);
    const xml = xmlPayloadCaptures.find((entry) => entry.index === 4)?.xml;
    expect(xml).toContain("<UserId>WORKSTATION\\alice</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(launcher).toContain(`WScript.Quit shell.Run("""${scriptPath}""", 0, True)`);
    expectTaskRunCall(6);
  });

  it("fails the install instead of writing an unrepresentable cmd launcher", async ({ env }) => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    schtasksResponses.push(missingTaskResponse);

    await expect(
      installDefaultGatewayTask(env, {
        environment: { OC_LABEL: "🚀" },
      }),
    ).rejects.toThrow(/cannot be represented in the Windows console code page/);
    await expect(fs.access(resolveTaskScriptPath(env))).rejects.toThrow();
  });

  it("installs an unattended Gateway with a batch action", async ({ env }) => {
    schtasksResponses.push(missingTaskResponse);
    const callerEnv: Record<string, string | undefined> = {
      ...env,
      HOME: env.USERPROFILE,
      USERDOMAIN: "WORKSTATION",
      USERNAME: "alice",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Custom Gateway",
    };
    const gatewayEnv = buildServiceEnvironment({
      env: callerEnv,
      port: 18789,
      platform: "win32",
    });

    expect(callerEnv.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
    expect(gatewayEnv.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBe("1");
    expect(gatewayEnv.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");

    const stdout = new PassThrough();
    const { scriptPath } = await installDefaultGatewayTask(callerEnv, {
      stdout,
      environment: {
        ...gatewayEnv,
        USERDOMAIN: "EVIL",
        USERNAME: "mallory",
      },
    });
    const launcherPath = scriptPath.replace(/\.cmd$/i, ".vbs");
    const script = await readScript(scriptPath);
    await expect(fs.access(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });

    expectTaskCreateCall(2, "OpenClaw Custom Gateway");
    const captured = xmlPayloadCaptures.find((entry) => entry.index === 2);
    expectContains(
      captured?.xml,
      [
        "<Command>C:\\Windows\\System32\\cmd.exe</Command>",
        `<Arguments>/d /s /c &quot;&quot;${scriptPath}&quot;&quot;</Arguments>`,
        `<WorkingDirectory>${path.dirname(scriptPath)}</WorkingDirectory>`,
        "<UserId>WORKSTATION\\alice</UserId>",
        "<LogonType>S4U</LogonType>",
        "<BootTrigger><Enabled>true</Enabled></BootTrigger>",
        "<LogonTrigger>",
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "<RestartOnFailure>",
        "<Interval>PT1M</Interval>",
        "<Count>3</Count>",
        "<RunLevel>LeastPrivilege</RunLevel>",
      ],
      ["<GroupId>S-1-5-32-545</GroupId>"],
    );
    expect(script).toContain("node gateway.js --task-supervisor < NUL");
    await expect(readScheduledTaskCommand(callerEnv)).resolves.toMatchObject({
      programArguments: ["node", "gateway.js"],
    });
    expect(script).toContain('set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Custom Gateway"');
    expect(script).toContain(
      'if not defined OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=cmd"',
    );
    expect(stdout.read(stdout.readableLength)?.toString()).toContain(
      "Unattended (S4U; boot and logon; no stored password)",
    );
    expectTaskRunCall(4, "OpenClaw Custom Gateway");
  });

  it("removes unmarked generated hidden launchers", async ({ env }) => {
    schtasksResponses.push(okSchtasksResponse, missingTaskResponse);
    const scriptPath = resolveTaskScriptPath(env);
    const parsedScriptPath = path.parse(scriptPath);
    const launcherPath = path.join(parsedScriptPath.dir, `${parsedScriptPath.name}.vbs`);
    await fs.mkdir(parsedScriptPath.dir, { recursive: true });
    await fs.writeFile(scriptPath, "@echo off\n", "utf8");
    await fs.writeFile(launcherPath, 'CreateObject("WScript.Shell")\n', "utf8");

    await uninstallScheduledTask({
      env,
      stdout: new PassThrough(),
    });

    for (const candidate of [scriptPath, launcherPath]) {
      await expect(fs.access(candidate)).rejects.toThrow();
    }
  });

  it("preserves Password credentials and triggers during refresh", async ({ env }) => {
    const xml =
      "<Task><Principals><Principal><UserId>operator</UserId><LogonType>Password</LogonType></Principal></Principals><Triggers><BootTrigger><Delay>PT30S</Delay></BootTrigger></Triggers><Actions><Exec><Command>gateway.cmd</Command></Exec></Actions></Task>";
    schtasksResponses.push({ code: 0, stdout: xml, stderr: "" });
    const stdout = new PassThrough();
    const { scriptPath } = await installDefaultGatewayTask(
      { ...env, USERNAME: "operator" },
      {
        stdout,
        environment: { OPENCLAW_SERVICE_KIND: "gateway" },
      },
    );
    expectCallSequence("/Query /Query /Query /Run");
    expect(xmlPayloadCaptures).toEqual([]);
    expect(await readScript(scriptPath)).toContain("node gateway.js --task-supervisor < NUL");
    expect(stdout.read(stdout.readableLength)?.toString()).toContain("Preserved Password task");
  });

  it("preserves task scripts when Scheduled Task deletion fails", async ({ env }) => {
    schtasksResponses.push(okSchtasksResponse, okSchtasksResponse, accessDeniedResponse);
    const scriptPath = resolveTaskScriptPath(env);
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, "@echo off\n", "utf8");

    await expect(uninstallScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
      "schtasks delete failed: ERROR: Access is denied.",
    );
    await fs.access(scriptPath);
  });

  it("warns and activates after an ordinary policy refresh fails", async ({ env }) => {
    schtasksResponses.push(okSchtasksResponse, okSchtasksResponse, accessDeniedResponse);
    const warn = vi.fn();
    await installDefaultGatewayTask(env, { warn, environment: undefined });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Access is denied"));
    expectCallSequence("/Query /Query /Query /Change /Create /Query /Run");
    expectTaskRunCall(6);
  });

  it("propagates /Run failure after registering a new task", async ({ env }) => {
    schtasksResponses.push(
      missingTaskResponse,
      okSchtasksResponse,
      okSchtasksResponse,
      accessDeniedResponse,
    );
    await expect(installDefaultGatewayTask(env)).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: "schtasks run failed: ERROR: Access is denied." }),
      ]),
    });
    expectInitialTaskQuery();
    expectCallSequence("/Query /Query /Create /Query /Run /Query /Change /End");
    expectTaskRunCall(4);
  });
});
