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
import { findExtraGatewayServices, renderGatewayServiceCleanupHints } from "./inspect.js";
import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import * as taskLayout from "./schtasks-layout.js";
import { resolveStartupEntryPath } from "./schtasks-layout.js";
import * as taskProcesses from "./schtasks-process.js";
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
  return { APPDATA: path.join(root, "appdata"), OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" };
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
  it.each(["OpenClaw Gateway", "Legacy recovery"])(
    "retains legacy Startup diagnostics without managed authority (%s)",
    async (taskName) => {
      const { startupPath, scriptPath } = await startup("cmd", taskName);
      await fs.writeFile(scriptPath, '@echo off\r\n"C:/Tools/clawdbot.exe" run\r\n');
      expect(await findExtraGatewayServices(environment(), { deep: true })).toEqual({
        services: [
          expect.objectContaining({
            platform: "win32",
            marker: "clawdbot",
            legacy: true,
            windowsStartupEntry: startupPath,
          }),
        ],
        errors: [],
      });
      expect(await discoverManagedGatewayBindings(environment())).toEqual([]);
    },
  );

  it.each([false, true])(
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
        expect(binding.profile).toBe(override ? "actual" : "rescue");
        expect(binding.env.OPENCLAW_PROFILE).toBe(override ? "actual" : "rescue");
        expect(binding.scope).toBe("user");
        expect(binding.env.OPENCLAW_WINDOWS_TASK_NAME).toBeUndefined();
      }
    },
  );

  it("keeps Startup runtime unknown when another verified Gateway owns the port", async () => {
    const { startupPath, scriptPath } = await startup("9.4");
    const foreignCommand =
      '"C:/Node/node.exe" "C:/Other/openclaw/dist/index.js" gateway --port 19789';
    vi.spyOn(taskProcesses, "readWindowsProcessSnapshot").mockReturnValue([
      { ProcessId: 4343, CommandLine: foreignCommand },
    ]);
    vi.spyOn(probeHosts, "resolveGatewayServiceProbeHosts").mockResolvedValue(["127.0.0.1"]);
    vi.spyOn(portsInspection, "inspectPortUsage").mockResolvedValue({
      port: 19789,
      status: "busy",
      listeners: [{ pid: 4343, commandLine: foreignCommand }],
      hints: [],
    });
    vi.spyOn(gatewayProcesses, "findVerifiedGatewayListenerPidsOnPortSync").mockReturnValue([4343]);
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: environment(),
      windowsStartupEntry: startupPath,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    expect(state.command?.sourcePath).toBe(scriptPath);
    expect(state.running).toBe(false);
    expect(state.runtime?.status).toBe("unknown");
    expect(state.runtime?.pid).toBeUndefined();
    expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "reads the exact Startup target without Task Scheduler (process inspected=%s)",
    async (inspected) => {
      const { startupPath, scriptPath } = await startup("9.4");
      vi.mocked(taskProbe.probeScheduledTaskState).mockImplementation(() => {
        throw new Error("Task Scheduler must not inspect a Startup file target");
      });
      vi.spyOn(taskProcesses, "readWindowsProcessSnapshot").mockReturnValue(
        inspected
          ? [
              {
                ProcessId: 4242,
                CommandLine:
                  '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789',
              },
            ]
          : null,
      );
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: environment(),
        windowsStartupEntry: startupPath,
        requireEffective: true,
        requireLoadedCommand: true,
      });
      expect(state.command).toMatchObject({ sourcePath: scriptPath });
      expect(state.env.OPENCLAW_PROFILE).toBe("rescue");
      expect(state.runtime).toMatchObject(
        inspected ? { status: "running", pid: 4242 } : { status: "unknown" },
      );
      expect(state.running).toBe(inspected);
      expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
      if (!inspected) {
        expect(state.runtime?.pid).toBeUndefined();
      }
    },
  );

  it.each([200, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
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

  it.each(["cmd", "9.2/9.3", "9.4"] as const)(
    "discovers an unselected sibling from real %s launcher files",
    async (form) => {
      const { startupPath, taskName } = await startup(form);
      expect(await findExtraGatewayServices(environment(), { deep: true })).toEqual({
        services: [
          expect.objectContaining({
            platform: "win32",
            label: taskName,
            scope: "user",
            marker: "openclaw",
            windowsStartupEntry: startupPath,
          }),
        ],
        errors: [],
      });
    },
  );

  it.each([false, true])(
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

  it("keeps a same-name Task and Startup definition distinct", async () => {
    const { startupPath, taskName } = await startup("9.4", "Recovery Alias");
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      {
        taskPath: taskName,
        state: 3,
        actions: [
          { type: 0, path: "C:/Other/openclaw.exe", arguments: "gateway", workingDirectory: "" },
        ],
      },
    ]);
    const inventory = await findExtraGatewayServices(environment(), { deep: true });
    expect(inventory.errors).toEqual([]);
    expect(inventory.services).toHaveLength(2);
    expect(inventory.services).toContainEqual(
      expect.objectContaining({ label: taskName, scope: "system" }),
    );
    const entry = inventory.services.find((service) => service.scope === "user");
    expect(entry).toMatchObject({ label: taskName, windowsStartupEntry: startupPath });
    expect(renderGatewayServiceCleanupHints(entry ? [entry] : [])).not.toContain(
      `schtasks /Delete /TN "${taskName}" /F`,
    );
  });

  it("still inspects Startup definitions when Task Scheduler is unavailable", async () => {
    const { startupPath } = await startup("9.2/9.3");
    vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
      throw new Error("unavailable");
    });
    const inventory = await findExtraGatewayServices(environment(), { deep: true });
    expect(inventory.services).toContainEqual(
      expect.objectContaining({ windowsStartupEntry: startupPath }),
    );
    expect(inventory.errors).toEqual([{ source: "schtasks", message: expect.any(String) }]);
  });

  it.each([
    { late: false, taskName: "OpenClaw Gateway (rescue)" },
    { late: true, taskName: "OpenClaw Gateway (rescue)" },
    { late: true, taskName: "Recovery" },
  ])(
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

  it("retains the original task identity when its Startup filename is sanitized", async () => {
    const { startupPath, scriptPath, taskName } = await startup("9.4", "\\Ops\\Recovery");
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
      status: "unknown",
      detail: "no Scheduler access",
      diagnostic: { kind: "native", exitCode: 1, hresult: -2147024891 },
    });
    const inventory = await findExtraGatewayServices(environment(), { deep: true });
    expect(inventory.errors).toEqual([]);
    expect(inventory.services).toContainEqual(
      expect.objectContaining({ label: taskName, windowsStartupEntry: startupPath }),
    );
    expect(await taskLayout.readStartupEntryCommand(startupPath)).toMatchObject({
      sourcePath: scriptPath,
      definitionPaths: [startupPath, scriptPath],
      programArguments: [
        "C:/Node/node.exe",
        "C:/Applications/openclaw/dist/index.js",
        "gateway",
        "--port",
        "19789",
      ],
      environment: {
        OPENCLAW_WINDOWS_TASK_NAME: taskName,
        OPENCLAW_PROFILE: "rescue",
        OPENCLAW_STATE_DIR: path.dirname(scriptPath),
      },
    });
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

  it("distinguishes a missing Startup directory from inaccessible discovery", async () => {
    const env = environment();
    expect(await findExtraGatewayServices(env, { deep: true })).toEqual({
      services: [],
      errors: [],
    });
    await fs.writeFile(env.APPDATA, "not a directory");
    expect(await findExtraGatewayServices(env, { deep: true })).toEqual({
      services: [],
      errors: [{ source: path.dirname(resolveStartupEntryPath(env)), message: expect.any(String) }],
    });
  });

  it("reports a non-directory ancestor when Windows labels it missing", async () => {
    const env = environment();
    await fs.writeFile(env.APPDATA, "not a directory");
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("scandir failed"), { code: "ENOENT" }),
    );
    expect(await findExtraGatewayServices(env, { deep: true })).toEqual({
      services: [],
      errors: [{ source: path.dirname(resolveStartupEntryPath(env)), message: expect.any(String) }],
    });
  });

  it.each([false, true])(
    "distinguishes missing Startup children from a dangling directory link (target exists=%s)",
    async (targetExists) => {
      const env = environment();
      const target = path.resolve(root, "redirected-appdata");
      if (targetExists) {
        await fs.mkdir(target);
      }
      await fs.symlink(target, env.APPDATA, "junction");
      expect(await findExtraGatewayServices(env, { deep: true })).toEqual({
        services: [],
        errors: targetExists
          ? []
          : [{ source: path.dirname(resolveStartupEntryPath(env)), message: expect.any(String) }],
      });
    },
  );

  it("reports an unreadable Startup directory instead of treating it as absent", async () => {
    const env = environment();
    const directory = path.dirname(resolveStartupEntryPath(env));
    await fs.mkdir(directory, { recursive: true });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("access denied"), { code: "EACCES" }),
    );
    expect(await findExtraGatewayServices(env, { deep: true })).toEqual({
      services: [],
      errors: [{ source: directory, message: expect.any(String) }],
    });
  });

  it("reports an unavailable Startup folder locator instead of claiming complete discovery", async () => {
    expect(await findExtraGatewayServices({}, { deep: true })).toEqual({
      services: [],
      errors: [{ source: "startup", message: expect.any(String) }],
    });
  });
});
