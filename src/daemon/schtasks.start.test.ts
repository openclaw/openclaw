import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { maybeRepairGatewayDaemon } from "../commands/doctor-gateway-daemon-flow.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import * as serviceRepairPolicy from "../commands/doctor-service-repair-policy.js";
import * as configPaths from "../config/paths.js";
import * as sqliteLibrary from "../infra/bun-sqlite-library.js";
import * as installOwner from "../infra/install-owner.js";
import * as ports from "../infra/ports-inspect.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as utils from "../utils.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import { startScheduledTask } from "./schtasks.js";
import * as gatewayService from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const native = vi.hoisted(() => ({
  enabled: false,
  enabledAvailable: true,
  running: false,
  scriptPath: "",
  taskName: "OpenClaw Gateway",
  afterEnable: undefined as (() => void | Promise<void>) | undefined,
  files: new Map<string, string>(),
  calls: [] as string[][],
}));
// Translate Windows fixture paths while keeping the real launcher reader and file fingerprinting.
vi.mock("./schtasks-inspection-deadline.js", async (original) => {
  const actual = await original<typeof import("./schtasks-inspection-deadline.js")>();
  return {
    ...actual,
    readTaskFile: (file: string, deadline?: number) =>
      actual.readTaskFile(native.files.get(file) ?? file, deadline),
  };
});
vi.mock("./service-stage.js", async (original) => {
  const actual = await original<typeof import("./service-stage.js")>();
  return {
    ...actual,
    readServiceFileState: (file: string) =>
      actual.readServiceFileState(native.files.get(file) ?? file),
  };
});
vi.mock("./program-args.js", async (original) => {
  const actual = await original<typeof import("./program-args.js")>();
  return {
    ...actual,
    resolveOpenClawWrapperPath: (file?: string) =>
      actual.resolveOpenClawWrapperPath(
        file === undefined ? undefined : (native.files.get(file) ?? file),
      ),
  };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify({
      taskPath: `\\${native.taskName}`,
      ...(native.enabledAvailable ? { enabled: native.enabled } : {}),
      state: native.running ? 4 : native.enabled ? 3 : 1,
      actions: [{ type: 0, path: native.scriptPath, arguments: "", workingDirectory: "" }],
    }),
  })),
}));
// mock-isolation: Native enable and Run mutations update only the selected task fixture.
vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: vi.fn(async (args: string[]) => {
    native.calls.push(args);
    if (args[0] === "/Change" && args.includes("/ENABLE")) {
      native.enabled = true;
      await native.afterEnable?.();
    }
    if (args[0] === "/Run") {
      if (!native.enabled) {
        return { code: 1, stdout: "", stderr: "The scheduled task is disabled." };
      }
      native.running = true;
    }
    return { code: 0, stdout: "", stderr: "" };
  }),
}));
vi.mock("./schtasks-runtime.js", async (original) => ({
  ...(await original<typeof import("./schtasks-runtime.js")>()),
  readScheduledTaskRuntime: vi.fn(async () => ({
    status: native.running ? "running" : "stopped",
  })),
}));
const temporary = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  native.enabled = false;
  native.enabledAvailable = true;
  native.running = false;
  native.calls.length = 0;
  native.files.clear();
  native.afterEnable = undefined;
});
afterEach(() => vi.restoreAllMocks());

async function fixture(kind = "gateway") {
  const root = temporary.make("schtasks-start-");
  const packageRoot = path.join(root, "package");
  await fs.mkdir(packageRoot);
  const entry = path.join(packageRoot, "openclaw.mjs");
  await fs.writeFile(entry, "export {};\n");
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
  native.scriptPath = "C:\\fixture\\gateway.cmd";
  const file = path.join(root, "gateway.cmd");
  native.files.set(native.scriptPath, file);
  await fs.writeFile(
    file,
    `@echo off\r\n"C:\\Node\\node.exe" "${entry}" ${kind === "node" ? "node run" : "gateway"}\r\n`,
  );
  native.taskName = kind === "node" ? "OpenClaw Node" : "OpenClaw Gateway";
  const env: Record<string, string> = {
    USERPROFILE: root,
    APPDATA: path.join(root, "appdata"),
    OPENCLAW_PROFILE: "default",
    OPENCLAW_WINDOWS_TASK_NAME: native.taskName,
    OPENCLAW_TASK_SCRIPT: native.scriptPath,
    OPENCLAW_SERVICE_KIND: kind,
  };
  return { env, file, root, entry };
}

it.each(["owned", "foreign", "missing launcher"] as const)(
  "recovers a disabled Scheduled Task through Doctor only with a verified launcher (%s)",
  async (scenario) => {
    const { env, root, file } = await fixture();
    if (scenario === "foreign") {
      await fs.writeFile(file, '@echo off\r\n"C:\\Windows\\notepad.exe" gateway\r\n');
    } else if (scenario === "missing launcher") {
      await fs.unlink(file);
    }
    const service = createMockGatewayService({
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "stopped", state: "Disabled" })),
      start: startScheduledTask,
    });
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
    vi.spyOn(configPaths, "isDefaultInstallIdentity").mockReturnValue(true);
    vi.spyOn(serviceRepairPolicy, "shouldManageGatewayService").mockResolvedValue(true);
    vi.spyOn(installOwner, "readInstallOwner").mockResolvedValue(null);
    vi.spyOn(utils, "sleep").mockResolvedValue(undefined);
    vi.spyOn(sqliteLibrary, "ensureSqliteLibrarySelected").mockReturnValue({ source: "runtime" });
    vi.spyOn(ports, "inspectPortUsage").mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const note = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
    mockProcessPlatform("win32");
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const options = { repair: true, nonInteractive: true };
    await withEnvAsync(
      {
        ...env,
        HOME: root,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      },
      () =>
        maybeRepairGatewayDaemon({
          cfg: { gateway: { mode: "local" } },
          runtime,
          options,
          prompter: createDoctorPrompter({ runtime, options }),
          gatewayDetailsMessage: "isolated task fixture",
          healthOk: false,
        }),
    );
    expect(native.enabled).toBe(scenario === "owned");
    expect(native.running).toBe(scenario === "owned");
    if (scenario !== "owned") {
      expect(native.calls.some((args) => args[0] === "/Change" || args[0] === "/Run")).toBe(false);
      expect(note).toHaveBeenCalledWith(
        expect.stringMatching(
          scenario === "foreign"
            ? /Gateway service start failed: .*not the requested OpenClaw service/
            : /Gateway service start failed: .*service command could not be inspected/,
        ),
        "Gateway",
      );
    }
  },
);

it("explicitly starts a disabled registered node without replacing its launcher", async () => {
  const { env, file } = await fixture("node");
  const before = await fs.readFile(file);
  const onMutation = vi.fn();
  await startScheduledTask({ env, stdout: new PassThrough(), onMutation });
  expect(native.enabled).toBe(true);
  expect(native.running).toBe(true);
  expect(await fs.readFile(file)).toEqual(before);
  expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }], [{ mode: "schtasks-start" }]]);
});

it("does not enable a captured service whose auto-start policy must be preserved", async () => {
  const { env } = await fixture();
  await expect(
    startScheduledTask({ env, stdout: new PassThrough(), preserveAutoStart: true }),
  ).rejects.toThrow("disabled");
  expect(native.enabled).toBe(false);
  expect(native.running).toBe(false);
  expect(native.calls.some((args) => args[0] === "/Change")).toBe(false);
});

it("preserves native Run with missing policy metadata (enabled=true)", async () => {
  const { env } = await fixture();
  native.enabled = true;
  native.enabledAvailable = false;
  const start = startScheduledTask({ env, stdout: new PassThrough() });
  await expect(start).resolves.toBeUndefined();
  expect(native.running).toBe(true);
  expect(native.calls.some((args) => args[0] === "/Run")).toBe(true);
  expect(native.calls.some((args) => args[0] === "/Change")).toBe(false);
});

it.each(["foreign entrypoint filename", "wrong profile", "multiple commands"])(
  "does not enable or run an unverified selected task (%s)",
  async (kind) => {
    const { env, file, root, entry } = await fixture();
    if (kind === "foreign entrypoint filename") {
      const foreign = path.join(root, "foreign");
      await fs.mkdir(foreign);
      await fs.writeFile(path.join(foreign, "package.json"), JSON.stringify({ name: "unrelated" }));
      const foreignEntry = path.join(foreign, "openclaw.mjs");
      await fs.writeFile(foreignEntry, "export {};\n");
      await fs.writeFile(file, `@echo off\r\n"C:\\Node\\node.exe" "${foreignEntry}" gateway\r\n`);
    } else {
      const program =
        kind === "wrong profile"
          ? `"C:\\Node\\node.exe" "${entry}" --profile other gateway`
          : `"C:\\Node\\node.exe" "${entry}" gateway\r\necho additional-command`;
      await fs.writeFile(file, `@echo off\r\n${program}\r\n`);
    }
    await expect(startScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow();
    expect(native.calls.filter((args) => args[0] === "/Change" || args[0] === "/Run")).toEqual([]);
    expect(native.enabled).toBe(false);
  },
);

it.each(["definition", "entrypoint", "authority"])(
  "revalidates %s after enable before running",
  async (kind) => {
    const { env, file, root, entry } = await fixture();
    let current = true;
    native.afterEnable = async () => {
      if (kind === "definition") {
        const replacement = path.join(root, "replacement");
        await fs.mkdir(replacement);
        await fs.writeFile(
          path.join(replacement, "package.json"),
          JSON.stringify({ name: "openclaw" }),
        );
        const replacementEntry = path.join(replacement, "openclaw.mjs");
        await fs.writeFile(replacementEntry, "export {};\n");
        await fs.writeFile(
          file,
          `@echo off\r\n"C:\\Node\\node.exe" "${replacementEntry}" gateway\r\n`,
        );
      } else if (kind === "entrypoint") {
        await fs.writeFile(entry, "export const changed = true;\n");
      } else {
        current = false;
      }
    };
    const onMutation = vi.fn();
    await expect(
      startScheduledTask({
        env,
        stdout: new PassThrough(),
        onMutation,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Caller authority lost");
          }
        },
      }),
    ).rejects.toThrow(kind === "authority" ? "Caller authority lost" : "changed before start");
    expect(native.calls.filter((args) => args[0] === "/Run")).toEqual([]);
    expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }]]);
  },
);

it("revalidates a registered VBS launcher across enable before running", async () => {
  const { env, root, entry } = await fixture();
  const cmd = native.scriptPath;
  const launcher = path.join(root, "gateway.vbs");
  native.scriptPath = "C:\\fixture\\gateway.vbs";
  native.files.set(native.scriptPath, launcher);
  await fs.writeFile(
    launcher,
    `Set shell = CreateObject("WScript.Shell")\r\nWScript.Quit shell.Run("""${cmd}""", 0, True)\r\n`,
  );
  const sources: string[] = [];
  // Published update drivers serialize this default command into their definition fingerprint.
  expect(
    await readScheduledTaskCommand(env, {
      requireEffective: true,
      requireLoaded: true,
      onLauncherContent: (_content, sourcePath) => sources.push(sourcePath),
    }),
  ).toEqual({
    programArguments: ["C:\\Node\\node.exe", entry, "gateway"],
    sourcePath: cmd,
  });
  expect(sources).toEqual([native.scriptPath, cmd]);
  native.afterEnable = () =>
    fs.writeFile(launcher, `CreateObject("WScript.Shell").Run """${cmd}""", 0, False\r\n`);
  await expect(startScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
    "changed before start",
  );
  expect(native.calls.some((args) => args[0] === "/Run")).toBe(false);
});

it.each([
  "persisted",
  "changed after enable",
  "ambient only",
  "mismatched",
  "missing executable",
  "root relative",
])("requires recorded and runnable wrapper intent before enabling (%s)", async (kind) => {
  const { env, file, root } = await fixture();
  const wrapper =
    kind === "root relative"
      ? "\\fixture\\operator-wrapper.exe"
      : "C:\\fixture\\operator-wrapper.exe";
  const executable = path.join(root, "operator-wrapper");
  native.files.set(wrapper, executable);
  if (kind !== "missing executable") {
    await fs.writeFile(executable, "fixture executable\n", { mode: 0o700 });
  }
  env.OPENCLAW_WRAPPER = wrapper;
  const saved =
    kind === "ambient only"
      ? ""
      : `set "OPENCLAW_WRAPPER=${kind === "mismatched" ? "C:\\fixture\\different-wrapper.exe" : wrapper}"\r\n`;
  await fs.writeFile(file, `@echo off\r\n${saved}"${wrapper}" gateway\r\n`);
  if (kind === "changed after enable") {
    native.afterEnable = () => fs.writeFile(executable, "replacement executable\n");
  }
  const start = startScheduledTask({ env, stdout: new PassThrough() });
  if (kind === "persisted") {
    await expect(start).resolves.toBeUndefined();
    expect(native.running).toBe(true);
  } else if (kind === "changed after enable") {
    await expect(start).rejects.toThrow("changed before start");
    expect(native.enabled).toBe(true);
    expect(native.calls.some((args) => args[0] === "/Run")).toBe(false);
  } else {
    await expect(start).rejects.toThrow();
    expect(native.calls.some((args) => args[0] === "/Change" || args[0] === "/Run")).toBe(false);
  }
});
