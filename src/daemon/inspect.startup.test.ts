import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { maybeScanExtraGatewayServices } from "../commands/doctor-gateway-services.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import * as doctorServicePolicy from "../commands/doctor-service-repair-policy.js";
import * as configPaths from "../config/paths.js";
import { CORE_HEALTH_CHECKS } from "../flows/doctor-core-checks.js";
import * as gatewayProcesses from "../infra/gateway-processes.js";
import * as portsInspection from "../infra/ports-inspect.js";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import * as probeHosts from "./gateway-service-probe-hosts.js";
import { findExtraGatewayServices } from "./inspect.js";
import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import * as taskLayout from "./schtasks-layout.js";
import { resolveStartupEntryPath } from "./schtasks-layout.js";
import * as taskProcesses from "./schtasks-process-snapshot.js";
import * as taskProbe from "./schtasks-state-probe.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const nativePlatform = process.platform;
let root: string;

beforeEach(async () => {
  vi.mocked(spawnSync).mockReset();
  // A UNC spelling also resolves to a real fixture directory on POSIX hosts.
  root = await fs.mkdtemp(
    nativePlatform === "win32"
      ? path.join(os.tmpdir(), "openclaw-startup-")
      : "\\\\openclaw-startup-",
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
  vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({ status: "missing" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function environment() {
  return {
    APPDATA: path.join(root, "appdata"),
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
    OPENCLAW_PROFILE: "default",
  };
}

async function startup(form: "cmd" | "9.2/9.3" | "9.4", taskName = "OpenClaw Gateway (rescue)") {
  const env = { ...environment(), OPENCLAW_WINDOWS_TASK_NAME: taskName };
  const startupPath = resolveStartupEntryPath(env, form === "cmd" ? "cmd" : "vbs");
  const scriptPath = path.join(root, path.basename(startupPath), "gateway.cmd");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(startupPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      'set "OPENCLAW_SERVICE_MARKER=openclaw"',
      'set "OPENCLAW_SERVICE_KIND=gateway"',
      `set "OPENCLAW_WINDOWS_TASK_NAME=${taskName}"`,
      `set "OPENCLAW_PROFILE=${taskName === "OpenClaw Gateway" ? "default" : "rescue"}"`,
      `set "OPENCLAW_STATE_DIR=${path.dirname(scriptPath)}"`,
      '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789 < NUL',
      "",
    ].join("\r\n"),
  );
  const content =
    form === "cmd"
      ? `@echo off\r\nstart "" /min cmd.exe /d /c "${scriptPath}"\r\n`
      : form === "9.4"
        ? `Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("Process")("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER") = "wscript"\r\nWScript.Quit shell.Run("""${scriptPath}""", 0, True)\r\n`
        : `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`;
  await fs.writeFile(
    startupPath,
    form === "cmd"
      ? Buffer.from(content, "utf8")
      : encodeWindowsLauncherScript({ format: "vbs", content }),
  );
  return { startupPath, scriptPath, taskName };
}

describe("Windows Startup service inventory", () => {
  it.each([
    { form: "cmd", taskName: "OpenClaw Gateway", legacy: true, scheduler: "missing" },
    {
      form: "9.2/9.3",
      taskName: "OpenClaw Gateway (rescue)",
      legacy: false,
      scheduler: "unavailable",
    },
  ] as const)(
    "discovers $taskName from $form (legacy=$legacy, Scheduler=$scheduler)",
    async ({ form, taskName, legacy, scheduler }) => {
      const { startupPath, scriptPath } = await startup(form, taskName);
      if (legacy) {
        await fs.writeFile(scriptPath, '@echo off\r\n"C:/Tools/clawdbot.exe" run\r\n');
      }
      if (scheduler === "unavailable") {
        vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
          throw new Error("unavailable");
        });
      }
      expect(await findExtraGatewayServices(environment(), { deep: true })).toEqual({
        services: [
          expect.objectContaining({
            platform: "win32",
            label: taskName,
            scope: "user",
            marker: legacy ? "clawdbot" : "openclaw",
            legacy,
            windowsStartupEntry: startupPath,
          }),
        ],
        errors:
          scheduler === "unavailable" ? [{ source: "schtasks", message: expect.any(String) }] : [],
      });
      if (legacy) {
        expect(await discoverManagedGatewayBindings(environment())).toEqual([]);
      }
    },
  );

  it.each([true])(
    "keeps same-label Startup files bound to their captured profile (argv override=%s)",
    async (override) => {
      const cmd = await startup("cmd", "Recovery alias");
      const vbs = await startup("9.4", "Recovery alias");
      if (override) {
        for (const { scriptPath } of [cmd, vbs]) {
          const script = await fs.readFile(scriptPath, "utf8");
          await fs.writeFile(
            scriptPath,
            script.replace(" gateway --port", " --profile actual gateway --port"),
          );
        }
      }
      const bindings = await discoverManagedGatewayBindings(environment());
      expect(bindings).toHaveLength(2);
      expect(bindings.map((binding) => binding.windowsStartupEntry)).toEqual(
        expect.arrayContaining([cmd.startupPath, vbs.startupPath]),
      );
      for (const binding of bindings) {
        expect(binding.env.OPENCLAW_PROFILE).toBe(override ? "actual" : "rescue");
        expect(binding.scope).toBe("user");
        expect(binding.env.OPENCLAW_WINDOWS_TASK_NAME).toBeUndefined();
      }
    },
  );

  it.each(["matching", "foreign"] as const)(
    "reads the exact Startup target without Task Scheduler (%s process)",
    async (processKind) => {
      const { startupPath, scriptPath } = await startup("9.4");
      vi.mocked(taskProbe.probeScheduledTaskState).mockImplementation(() => {
        throw new Error("Task Scheduler must not inspect a Startup file target");
      });
      const foreignCommand =
        '"C:/Node/node.exe" "C:/Other/openclaw/dist/index.js" gateway --port 19789';
      vi.spyOn(taskProcesses, "readWindowsProcessSnapshot").mockReturnValue([
        {
          ProcessId: processKind === "matching" ? 4242 : 4343,
          CommandLine:
            processKind === "matching"
              ? '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789'
              : foreignCommand,
        },
      ]);
      if (processKind === "foreign") {
        vi.spyOn(probeHosts, "resolveGatewayServiceProbeHosts").mockResolvedValue(["127.0.0.1"]);
        vi.spyOn(portsInspection, "inspectPortUsage").mockResolvedValue({
          port: 19789,
          status: "busy",
          listeners: [{ pid: 4343, commandLine: foreignCommand }],
          hints: [],
        });
        vi.spyOn(gatewayProcesses, "findVerifiedGatewayListenerPidsOnPortSync").mockReturnValue([
          4343,
        ]);
      }
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: environment(),
        windowsStartupEntry: startupPath,
        requireEffective: true,
        requireLoadedCommand: true,
      });
      expect(state.command?.sourcePath).toBe(scriptPath);
      expect(state.env.OPENCLAW_PROFILE).toBe("rescue");
      expect(state.runtime).toMatchObject(
        processKind === "matching" ? { status: "running", pid: 4242 } : { status: "unknown" },
      );
      expect(state.running).toBe(processKind === "matching");
      expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
      if (processKind !== "matching") {
        expect(state.runtime?.pid).toBeUndefined();
      }
    },
  );

  it.each([200])(
    "bounds exact Startup native process inspection by the caller's deadline (%s)",
    async (timeoutMs) => {
      const { startupPath } = await startup("9.4");
      let now = 10_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
        const timeout = options?.timeout ?? Infinity;
        now += Math.min(timeout, 250);
        return {
          pid: 0,
          output: [null, "", ""],
          stdout: JSON.stringify([
            {
              ProcessId: 4242,
              CommandLine:
                '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789',
            },
          ]),
          stderr: "",
          status: timeout < 250 ? null : 0,
          signal: timeout < 250 ? "SIGTERM" : null,
          ...(timeout < 250
            ? { error: Object.assign(new Error("Native probe timed out"), { code: "ETIMEDOUT" }) }
            : {}),
        };
      });
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: environment(),
        windowsStartupEntry: startupPath,
        timeoutMs,
      });
      expect(now).toBe(10_000 + (timeoutMs === 200 ? 200 : 0));
      expect(spawnSync).toHaveBeenCalledTimes(timeoutMs === 200 ? 1 : 0);
      expect(state.running).toBe(false);
      expect(state.runtime).toMatchObject({
        status: "unknown",
        inspectionFailure: { timeoutMs },
      });
      expect(state.runtime?.pid).toBeUndefined();
      expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "accepts exact Startup port absence only before its remaining deadline (late=%s)",
    async (late) => {
      const { startupPath } = await startup("9.4");
      let now = 10_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const nativeBudgets: number[] = [];
      vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
        nativeBudgets.push(options?.timeout ?? Infinity);
        const portRead = args?.join(" ").includes("Get-NetTCPConnection");
        now += portRead ? (late ? 170 : 50) : 40;
        return {
          pid: 1234,
          output: [null, "", ""],
          stdout: portRead
            ? "0\r\n"
            : JSON.stringify([{ ProcessId: 9999, CommandLine: "unrelated.exe" }]),
          stderr: "",
          status: 0,
          signal: null,
        };
      });
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: environment(),
        windowsStartupEntry: startupPath,
        timeoutMs: 200,
      });
      expect(nativeBudgets).toEqual([200, 160]);
      expect(state.running).toBe(false);
      expect(state.runtime?.status).toBe(late ? "unknown" : "stopped");
      expect(state.runtime?.pid).toBeUndefined();
      if (late) {
        expect(state.runtime?.inspectionFailure).toMatchObject({ timeoutMs: 200 });
      }
      expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
    },
  );

  it.each(["initial", "revalidation"] as const)(
    "settles exact Startup inspection when its %s file read stalls",
    async (phase) => {
      const { startupPath } = await startup("9.4");
      const original = await fs.readFile(startupPath);
      const pending = createDeferred<typeof original>();
      const entered = createDeferred();
      let nativeRead = false;
      let signal: AbortSignal | undefined;
      vi.mocked(spawnSync).mockImplementation(() => {
        nativeRead = true;
        return {
          pid: 1234,
          output: [null, "", ""],
          stdout: JSON.stringify([
            {
              ProcessId: 4242,
              CommandLine:
                '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789',
            },
          ]),
          stderr: "",
          status: 0,
          signal: null,
        };
      });
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation((...args) => {
        if (args[0] === startupPath && (phase === "initial" || nativeRead)) {
          const options = args[1];
          signal = typeof options === "object" && options !== null ? options.signal : undefined;
          entered.resolve();
          return pending.promise;
        }
        return readFile(...args);
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      let result: Awaited<ReturnType<typeof readGatewayServiceState>> | undefined;
      const inspection = readGatewayServiceState(resolveGatewayService(), {
        env: environment(),
        windowsStartupEntry: startupPath,
        timeoutMs: 200,
      }).then((state) => {
        result = state;
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(200);
        expect(result).toMatchObject({
          running: false,
          runtime: { status: "unknown", inspectionFailure: { timeoutMs: 200 } },
        });
        expect(signal?.aborted).toBe(true);
        expect(nativeRead).toBe(phase === "revalidation");
      } finally {
        pending.resolve(original);
        await inspection;
        vi.useRealTimers();
      }
    },
  );

  it.each(["launcher", "script"] as const)(
    "rejects a changed Startup %s after runtime inspection",
    async (changed) => {
      const { startupPath, scriptPath } = await startup("9.4");
      const changedPath = changed === "launcher" ? startupPath : scriptPath;
      const original = await fs.readFile(changedPath);
      vi.spyOn(taskProcesses, "readWindowsProcessSnapshot").mockImplementation(() => {
        writeFileSync(
          changedPath,
          Buffer.concat([
            original,
            Buffer.from("\r\n", changed === "launcher" ? "utf16le" : "utf8"),
          ]),
        );
        return null;
      });
      await expect(
        readGatewayServiceState(resolveGatewayService(), {
          env: environment(),
          windowsStartupEntry: startupPath,
          requireEffective: true,
          requireLoadedCommand: true,
        }),
      ).rejects.toThrow("Startup launcher changed during runtime inspection");
    },
  );

  it.each([true])(
    "reports Startup entries through Doctor (selected Task exists=%s)",
    async (taskExists) => {
      const selected = await startup("9.4", "OpenClaw Gateway");
      const sibling = await startup("9.4");
      if (taskExists) {
        const task = {
          taskPath: selected.taskName,
          state: 3,
          actions: [{ type: 0, path: selected.scriptPath, arguments: "", workingDirectory: "" }],
        };
        vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([task]);
        vi.mocked(taskProbe.probeScheduledTaskState).mockReturnValue({ status: "found", ...task });
      }
      for (const [key, value] of Object.entries(environment())) {
        vi.stubEnv(key, value);
      }
      // Keep the synthetic account eligible; discovery, parsing, and reporting stay real.
      vi.spyOn(configPaths, "isDefaultInstallIdentity").mockReturnValue(true);
      vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
      const notes = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const check = CORE_HEALTH_CHECKS.find(
        ({ id }) => id === "core/doctor/gateway-services/extra",
      );
      if (!check) {
        throw new Error("Doctor extra-services check is not registered");
      }
      const context = { mode: "doctor" as const, cfg: {}, runtime, deep: true };
      const extras = taskExists ? [sibling, selected] : [sibling];
      expect(await check.detect(context)).toEqual(
        extras.map((entry) =>
          expect.objectContaining({
            severity: "info",
            target: entry.taskName,
            message: expect.stringContaining(entry.startupPath),
          }),
        ),
      );
      await maybeScanExtraGatewayServices(
        { deep: true },
        runtime,
        createDoctorPrompter({ runtime, options: { nonInteractive: true } }),
      );
      const output = notes.mock.calls.map(([message]) => message).join("\n");
      expect(output).toContain(`Get-Item -LiteralPath '${sibling.startupPath}'`);
      if (taskExists) {
        expect(output).toContain(`Get-Item -LiteralPath '${selected.startupPath}'`);
      } else {
        expect(output).not.toContain(selected.startupPath);
      }
      expect(output).not.toContain("schtasks /Delete");
    },
  );

  it.each([{ late: true, taskName: "Recovery" }])(
    "shares the inventory deadline with Startup launcher reads ($taskName, late=$late)",
    async ({ late, taskName }) => {
      const { startupPath } = await startup("9.4", taskName);
      let now = 10_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
        now += 59_990;
        return [];
      });
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const contents = await readFile(...args);
        if (args[0] === startupPath && late) {
          now += 20;
        }
        return contents;
      });
      const inventory = await findExtraGatewayServices(environment(), { deep: true });
      expect(inventory.services).toHaveLength(late ? 0 : 1);
      if (late) {
        expect(inventory.errors).toContainEqual({
          source: startupPath,
          message: "Startup launcher could not be inspected.",
        });
      } else {
        expect(inventory.errors).toEqual([]);
        expect(inventory.services[0]?.windowsStartupEntry).toBe(startupPath);
      }
    },
  );

  it("retains the last completed Task while reporting an exhausted Startup scan", async () => {
    const { startupPath, taskName } = await startup("9.4", "Recovery");
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const task = {
      taskPath: taskName,
      state: 3,
      actions: [{ type: 0, path: startupPath, arguments: "", workingDirectory: "" }],
    };
    vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
      now += 50_000;
      return [task];
    });
    vi.mocked(taskProbe.probeScheduledTaskState).mockImplementation(() => {
      now += 4_999.75;
      return { status: "found", ...task };
    });
    const inventory = await findExtraGatewayServices(environment(), { deep: true });
    expect(now).toBe(69_999.5);
    expect(inventory.services).toEqual([
      expect.objectContaining({ label: taskName, detail: expect.stringMatching(/^task:/) }),
    ]);
    expect(inventory.errors).toEqual([
      { source: "schtasks", message: expect.stringMatching(/deadline expired/) },
    ]);
  });

  it.each(["entry", "script"] as const)(
    "rejects the %s retargeted during inspection",
    async (changed) => {
      const { startupPath, scriptPath } = await startup("9.4");
      await expect(
        taskLayout.readStartupEntryCommand(startupPath, {
          onLauncherContent: (content) => {
            if (content.includes("OPENCLAW_SERVICE_KIND")) {
              writeFileSync(
                changed === "entry" ? startupPath : scriptPath,
                "changed after capture",
              );
            }
          },
        }),
      ).rejects.toThrow("Startup service command could not be inspected.");
    },
  );

  it("reports recognizable malformed and unreadable entries without treating unrelated files as Gateways", async () => {
    const env = { ...environment(), OPENCLAW_WINDOWS_TASK_NAME: "Selected Custom" };
    const directory = path.dirname(resolveStartupEntryPath(env));
    await fs.mkdir(directory, { recursive: true });
    const selected = resolveStartupEntryPath(env, "vbs");
    const branded = path.join(directory, "Private Alias.vbs");
    const unreadable = path.join(directory, "OpenClaw Gateway Broken.cmd");
    await fs.writeFile(selected, "unrecognized");
    await fs.writeFile(branded, "node C:\\openclaw\\dist\\entry.js gateway\r\nunrecognized");
    await fs.mkdir(unreadable);
    await fs.writeFile(path.join(directory, "Other.vbs"), "' OpenClaw Gateway\r\nunrecognized");
    const inventory = await findExtraGatewayServices(env, { deep: true });
    expect(inventory.services).toEqual([]);
    expect(inventory.errors.map(({ source }) => source).toSorted()).toEqual(
      ["Selected Custom", selected, branded, unreadable].toSorted(),
    );
  });

  it.each(["non-directory ENOENT", "unreadable", "unavailable locator"] as const)(
    "reports Startup discovery for %s",
    async (kind) => {
      const env = environment();
      const directory = path.dirname(resolveStartupEntryPath(env));
      if (kind === "non-directory ENOENT") {
        await fs.writeFile(env.APPDATA, "not a directory");
        if (kind === "non-directory ENOENT") {
          vi.spyOn(fs, "readdir").mockRejectedValueOnce(
            Object.assign(new Error("scandir failed"), { code: "ENOENT" }),
          );
        }
      } else if (kind === "unreadable") {
        await fs.mkdir(directory, { recursive: true });
        vi.spyOn(fs, "readdir").mockRejectedValueOnce(
          Object.assign(new Error("access denied"), { code: "EACCES" }),
        );
      }
      expect(
        await findExtraGatewayServices(kind === "unavailable locator" ? {} : env, { deep: true }),
      ).toEqual({
        services: [],
        errors: [
          {
            source: kind === "unavailable locator" ? "startup" : directory,
            message: expect.any(String),
          },
        ],
      });
    },
  );
});
