import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installScheduledTask, stageScheduledTask } from "./schtasks-install.js";
import {
  buildTaskScript,
  encodeWindowsLauncherScript,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import type { GatewayServiceDefinitionTransactionHooks } from "./service-stage.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

const native = vi.hoisted(() => ({
  exec: vi.fn<typeof import("./schtasks-exec.js").execSchtasks>(),
  run: vi.fn<typeof import("./schtasks-control.js").runScheduledTaskOrThrow>(),
  probe: vi.fn<typeof import("./schtasks-state-probe.js").probeScheduledTaskState>(),
  runtime: vi.fn<typeof import("./schtasks-runtime.js").resolveFallbackRuntime>(),
  running: vi.fn<typeof import("./schtasks-runtime.js").waitForScheduledTaskRunningEvidence>(),
  stop: vi.fn<typeof import("./schtasks-control.js").stopRegisteredScheduledTask>(),
}));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.exec }));
vi.mock("./schtasks-control.js", async (original) => ({
  ...(await original<typeof import("./schtasks-control.js")>()),
  runScheduledTaskOrThrow: native.run,
  stopRegisteredScheduledTask: native.stop,
}));
vi.mock("./service-operation-lock.js", () => ({
  withGatewayServiceOperationLock: async (
    _env: unknown,
    operation: (assertCurrent: () => void) => Promise<unknown>,
  ) =>
    operation(() => {
      assertGatewayServiceUpdateCurrent();
    }),
}));
// mock-isolation: Task Scheduler COM state belongs to the synthetic installer fixture.
vi.mock("./schtasks-state-probe.js", () => ({
  probeScheduledTaskState: native.probe,
  probeScheduledTaskExists: (name: string) => native.probe(name).status === "found",
}));
vi.mock("./schtasks-runtime.js", async (original) => ({
  ...(await original<typeof import("./schtasks-runtime.js")>()),
  isStartupEntryInstalled: async () => false,
  resolveFallbackRuntime: native.runtime,
  waitForScheduledTaskRunningEvidence: native.running,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
const originalXml =
  "<Task><Settings><Enabled>false</Enabled></Settings><Actions><Exec><Command>original</Command></Exec></Actions></Task>";
beforeEach(() => {
  native.exec.mockReset();
  native.run.mockReset().mockResolvedValue("scheduled-task");
  native.probe.mockReset().mockReturnValue({ status: "found", state: 1, enabled: false });
  native.runtime.mockReset().mockResolvedValue({ status: "stopped" });
  native.running.mockReset().mockResolvedValue(true);
  native.stop.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

async function fixture(enabled = false) {
  const savedXml = enabled ? originalXml.replace("<Enabled>false", "<Enabled>true") : originalXml;
  const root = temporary.make("openclaw-task-rollback-");
  const env = {
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
  };
  const scriptPath = resolveTaskScriptPath(env);
  const launcherPath = scriptPath.replace(/\.cmd$/u, ".vbs");
  const original = encodeWindowsLauncherScript({
    format: "cmd",
    content: buildTaskScript({
      programArguments: ["node", "/prefix-a/openclaw/dist/index.js", "gateway"],
    }),
  });
  await fs.writeFile(scriptPath, original);
  await fs.writeFile(launcherPath, "original hidden launcher");
  const registration = { xml: savedXml };
  native.exec.mockImplementation(async (command) => {
    assertGatewayServiceUpdateCurrent();
    if (command[0] === "/Query") {
      return { code: 0, stdout: registration.xml, stderr: "" };
    }
    if (command[0] === "/Create") {
      registration.xml = (await fs.readFile(command.at(-1)!)).subarray(2).toString("utf16le");
    }
    if (command.includes("/DISABLE")) {
      registration.xml = registration.xml.replace(/(<Settings>[\s\S]*?<Enabled>)true/u, "$1false");
    }
    if (command.includes("/ENABLE")) {
      registration.xml = registration.xml.replace(/(<Settings>[\s\S]*?<Enabled>)false/u, "$1true");
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const args = {
    env,
    stdout: new PassThrough(),
    warn: vi.fn(),
    programArguments: ["node", "/prefix-b/openclaw/dist/index.js", "gateway"],
  };
  const assertRestored = async () => {
    expect(await fs.readFile(scriptPath)).toEqual(original);
    expect(await fs.readFile(launcherPath, "utf8")).toBe("original hidden launcher");
    expect(registration.xml).toBe(savedXml);
  };
  const assertBackups = async () => {
    expect(await fs.readFile(`${scriptPath}.bak`)).toEqual(original);
    expect(await fs.readFile(`${launcherPath}.bak`, "utf8")).toBe("original hidden launcher");
    expect((await fs.readFile(`${scriptPath}.task.xml.bak`)).subarray(2).toString("utf16le")).toBe(
      savedXml,
    );
  };
  return { args, scriptPath, launcherPath, original, registration, assertRestored, assertBackups };
}

it.each(["runtime", "arguments", "environment"])(
  "replaces a running registered task before publishing a changed %s",
  async (change) => {
    const { args, scriptPath, original } = await fixture(true);
    let running = original;
    native.probe.mockReturnValue({ status: "found", state: 4, enabled: true });
    native.stop.mockImplementation(async (params) => {
      expect(await fs.readFile(scriptPath)).toEqual(original);
      running = Buffer.alloc(0);
      params.onEndMutation?.();
      return false;
    });
    native.run.mockImplementation(async () => {
      // Task Scheduler's IgnoreNew keeps the old process until it has exited.
      if (running.length === 0) {
        running = await fs.readFile(scriptPath);
      }
      return "scheduled-task";
    });
    await installScheduledTask({
      ...args,
      programArguments:
        change === "runtime"
          ? ["bun", "/prefix-a/openclaw/dist/index.js", "gateway"]
          : change === "arguments"
            ? args.programArguments
            : ["node", "/prefix-a/openclaw/dist/index.js", "gateway"],
      ...(change === "environment" ? { environment: { SYNTHETIC_SETTING: "updated" } } : {}),
    });
    expect(running).toEqual(await fs.readFile(scriptPath));
    expect(running).not.toEqual(original);
  },
);

it.each(
  [
    { initialState: 4, wasRunning: true },
    { initialState: 3, wasRunning: true },
    { initialState: 1, wasRunning: true },
    { initialState: 3, wasRunning: false },
  ].flatMap((prior) =>
    ["publication", "activation"].map((phase) => ({
      initialState: prior.initialState,
      wasRunning: prior.wasRunning,
      phase,
    })),
  ),
)(
  "restores actual process liveness after $phase failure (task $initialState, running $wasRunning)",
  async ({ initialState, wasRunning, phase }) => {
    const { args, scriptPath, assertRestored } = await fixture(initialState !== 1);
    let running = wasRunning;
    let taskState = initialState;
    let enabled = initialState !== 1;
    native.probe.mockImplementation(() => ({
      status: "found",
      state: taskState,
      enabled,
    }));
    native.runtime.mockImplementation(async () => ({ status: running ? "running" : "stopped" }));
    if (!wasRunning) {
      native.runtime.mockResolvedValueOnce({ status: "unknown" });
    }
    native.stop.mockImplementation(async (params) => {
      if (running) {
        params.onProcessStopped?.();
      }
      running = false;
      taskState = enabled ? 3 : 1;
      params.onEndMutation?.();
      return false;
    });
    const execute = native.exec.getMockImplementation()!;
    native.exec.mockImplementation(async (command) => {
      if (command[0] === "/Run") {
        running = true;
        taskState = 4;
      }
      if (command[0] === "/End") {
        running = false;
        taskState = enabled ? 3 : 1;
      }
      if (command.includes("/DISABLE")) {
        enabled = false;
      }
      if (command.includes("/ENABLE")) {
        enabled = true;
      }
      return execute(command);
    });
    const rename = fs.rename;
    let rejected = false;
    vi.spyOn(fs, "rename").mockImplementation(async (...parameters) => {
      if (phase === "publication" && !rejected && parameters[1] === scriptPath) {
        rejected = true;
        expect(running).toBe(false);
        throw new Error("Synthetic publication failure");
      }
      return rename(...parameters);
    });
    if (phase === "activation") {
      native.run.mockRejectedValueOnce(new Error("Synthetic activation failure"));
    }
    await expect(installScheduledTask(args)).rejects.toThrow(`Synthetic ${phase} failure`);
    await assertRestored();
    expect(running).toBe(wasRunning);
    expect(native.run).toHaveBeenCalledTimes(phase === "publication" ? 0 : 1);
  },
);

it.each(["process", "definition"])(
  "preserves a replacement %s observed during stop",
  async (kind) => {
    const { args, scriptPath, original, registration } = await fixture(true);
    native.probe.mockReturnValue({ status: "found", state: 4, enabled: true });
    const foreign =
      "<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>operator</Command></Exec></Actions></Task>";
    native.stop.mockImplementation(async (params) => {
      if (kind === "definition") {
        params.onEndMutation?.();
        registration.xml = foreign;
      }
      return kind === "process";
    });
    await expect(installScheduledTask(args)).rejects.toThrow();
    expect(await fs.readFile(scriptPath)).toEqual(original);
    if (kind === "definition") {
      expect(registration.xml).toBe(foreign);
    }
    expect(native.run).not.toHaveBeenCalled();
    expect(native.exec.mock.calls.every(([command]) => command[0] === "/Query")).toBe(true);
  },
);

it.each(["inspection", "enablement", "queued"] as const)(
  "preserves the original process when recovery cannot capture its %s state",
  async (missing) => {
    const { args, scriptPath, original } = await fixture(true);
    native.probe.mockReturnValue(
      missing === "inspection"
        ? {
            status: "unknown",
            detail: "Synthetic native timeout",
            diagnostic: { kind: "timeout", timeoutMs: 1 },
          }
        : missing === "enablement"
          ? { status: "found", state: 4 }
          : { status: "found", state: 2, enabled: true },
    );
    native.run.mockRejectedValueOnce(new Error("Synthetic activation failure"));
    await expect(installScheduledTask(args)).rejects.toThrow();
    expect(native.stop).not.toHaveBeenCalled();
    expect(native.run).not.toHaveBeenCalled();
    expect(await fs.readFile(scriptPath)).toEqual(original);
  },
);

it.each(["stopped", "running", "unknown"] as const)(
  "uses admitted stopped-state evidence without reacquiring update custody (%s)",
  async (evidence) => {
    const { args, scriptPath, original } = await fixture(true);
    native.probe.mockReturnValue({
      status: "found",
      state: evidence === "running" ? 4 : 3,
      enabled: true,
    });
    native.runtime.mockResolvedValue({ status: evidence === "unknown" ? "unknown" : "stopped" });
    native.stop.mockImplementation(async () => {
      expect(await fs.readFile(scriptPath)).toEqual(original);
      if (evidence !== "running") {
        throw new Error("Stopped-state ownership cannot be acquired");
      }
      return false;
    });
    const definitionTransaction: GatewayServiceDefinitionTransactionHooks = {
      assertCurrent: () => {},
      beforeWrite: async () => {},
      filePrepared: async () => {},
      fileWritten: async () => {},
      taskPrepared: async () => {},
      taskWritten: async () => {},
    };
    const install = installScheduledTask({ ...args, definitionTransaction });
    if (evidence === "unknown") {
      await expect(install).rejects.toThrow("Stopped-state ownership cannot be acquired");
      expect(await fs.readFile(scriptPath)).toEqual(original);
      expect(native.run).not.toHaveBeenCalled();
    } else {
      await install;
      expect(await fs.readFile(scriptPath)).not.toEqual(original);
      expect(native.stop).toHaveBeenCalledTimes(evidence === "running" ? 1 : 0);
      expect(native.run).toHaveBeenCalledOnce();
    }
  },
);

function installWithCustody(
  args: Parameters<typeof installScheduledTask>[0],
  revoked: () => boolean,
) {
  return withGatewayServiceUpdateAuthority(
    () => {
      if (revoked()) {
        throw new Error("Doctor custody revoked");
      }
    },
    () => installScheduledTask(args),
    { updateOwned: false, assertRecoveryCurrent: () => {} },
  );
}

it("leaves both original launchers intact when staging cannot capture the hidden launcher", async () => {
  const { args, scriptPath, launcherPath, original } = await fixture();
  await fs.unlink(launcherPath);
  await fs.mkdir(launcherPath);
  await expect(stageScheduledTask(args)).rejects.toThrow();
  expect(await fs.readFile(scriptPath)).toEqual(original);
  expect((await fs.stat(launcherPath)).isDirectory()).toBe(true);
});

it.each(["registration", "xml-upgrade"])("preserves recovery when %s fails", async (failure) => {
  const { args, scriptPath, assertRestored, assertBackups } = await fixture();
  const execute = native.exec.getMockImplementation()!;
  native.exec.mockImplementation(async (command) =>
    command[0] === "/Create" || (failure === "registration" && command[0] === "/Change")
      ? { code: 2, stdout: "", stderr: "registration rejected" }
      : execute(command),
  );
  const installation = installScheduledTask(args);
  if (failure === "xml-upgrade") {
    await expect(installation).resolves.toEqual({ scriptPath });
    expect(args.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /launch command.*refreshed.*XML settings.*battery settings.*not.*registration rejected.*Inspect Task Scheduler.*retry the service installation/u,
      ),
    );
    expect(native.run).toHaveBeenCalledOnce();
    expect((await readScheduledTaskCommand(args.env))?.programArguments).toEqual(
      args.programArguments,
    );
  } else {
    await expect(installation).rejects.toThrow("registration rejected");
    await assertRestored();
    expect(native.run).not.toHaveBeenCalled();
    expect(args.warn).not.toHaveBeenCalled();
  }
  await assertBackups();
});

it.each([
  "backup-read",
  "before-publication",
  "partial-publication",
  "before-activation",
  "after-registration",
  "during-activation",
])("compensates only owned effects after custody revocation %s", async (phase) => {
  const { args, scriptPath, launcherPath, assertRestored, assertBackups } = await fixture();
  let revoked = false;
  const execute = native.exec.getMockImplementation()!;
  native.exec.mockImplementation(async (command) => {
    const result = await execute(command);
    if (phase === "backup-read" && command[0] === "/Query") {
      revoked = true;
      assertGatewayServiceUpdateCurrent();
    }
    if (
      phase === "after-registration" &&
      command[0] === "/Query" &&
      result.stdout !== originalXml
    ) {
      revoked = true;
    }
    return result;
  });
  const rename = fs.rename;
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...parameters) => {
    const handle = await open(...parameters);
    if (
      phase === "before-publication" &&
      typeof parameters[0] === "string" &&
      parameters[0].startsWith(
        path.join(path.dirname(scriptPath), `.${path.basename(scriptPath)}.openclaw`),
      )
    ) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await sync();
        revoked = true;
      });
    }
    return handle;
  });
  vi.spyOn(fs, "rename").mockImplementation(async (...parameters) => {
    await rename(...parameters);
    if (
      (phase === "partial-publication" && parameters[1] === scriptPath) ||
      (phase === "before-activation" && parameters[1] === launcherPath)
    ) {
      revoked = true;
    }
  });
  native.run.mockImplementation(async () => {
    revoked = true;
    return "scheduled-task";
  });
  await expect(installWithCustody(args, () => revoked)).rejects.toMatchObject({
    code: "service-authority-revoked",
    outcome: phase === "before-publication" || phase === "backup-read" ? "unchanged" : "restored",
  });
  await assertRestored();
  if (phase === "backup-read") {
    await expect(fs.stat(`${scriptPath}.task.xml.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${scriptPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await assertBackups();
  }
  const mutations = native.exec.mock.calls
    .map(([command]) => command)
    .filter((command) => command[0] !== "/Query");
  if (phase === "during-activation" || phase === "after-registration") {
    expect(mutations.map((command) => command[0])).toEqual([
      "/Change",
      "/Create",
      "/Change",
      "/End",
      "/Create",
    ]);
    expect(mutations[2]).toContain("/DISABLE");
  } else {
    expect(mutations).toEqual([]);
    expect(native.run).not.toHaveBeenCalled();
  }
  expect(args.warn).not.toHaveBeenCalled();
});

it.each(["before-rename", "after-rename", "foreign-after-rename"])(
  "settles a launcher publication failure %s before reporting recovery",
  async (phase) => {
    const { args, scriptPath, launcherPath, original, assertRestored, assertBackups } =
      await fixture();
    await fs.chmod(scriptPath, 0o640);
    // Windows chmod exposes writability, not distinct owner/group permission bits.
    const originalMode = (await fs.stat(scriptPath)).mode & 0o7777;
    let revoked = false;
    let renamed = false;
    let faulted = false;
    let foreignInode: number | undefined;
    const rename = fs.rename;
    const open = fs.open;
    vi.spyOn(fs, "rename").mockImplementation(async (...parameters) => {
      if (!faulted && parameters[1] === scriptPath && phase === "before-rename") {
        faulted = true;
        revoked = true;
        throw new Error("Launcher rename rejected");
      }
      await rename(...parameters);
      if (parameters[1] === scriptPath) {
        renamed = true;
      }
    });
    vi.spyOn(fs, "open").mockImplementation(async (...parameters) => {
      const handle = await open(...parameters);
      if (
        parameters[1] === "wx" &&
        typeof parameters[0] === "string" &&
        parameters[0].startsWith(
          path.join(path.dirname(scriptPath), `.${path.basename(scriptPath)}.openclaw`),
        )
      ) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          if (!renamed || faulted) {
            return;
          }
          faulted = true;
          if (phase === "foreign-after-rename") {
            const replacement = `${scriptPath}.operator`;
            await fs.writeFile(replacement, await fs.readFile(scriptPath), { mode: 0o600 });
            await rename(replacement, scriptPath);
            foreignInode = (await fs.stat(scriptPath)).ino;
          }
          revoked = true;
          throw new Error("Published launcher descriptor close failed");
        });
      }
      return handle;
    });

    await expect(installWithCustody(args, () => revoked)).rejects.toMatchObject({
      code: "service-authority-revoked",
      outcome:
        phase === "before-rename"
          ? "unchanged"
          : phase === "after-rename"
            ? "restored"
            : "recovery-pending",
    });
    expect(faulted).toBe(true);
    if (phase === "foreign-after-rename") {
      expect((await fs.stat(scriptPath)).ino).toBe(foreignInode);
      expect(await fs.readFile(scriptPath)).not.toEqual(original);
      expect(await fs.readFile(launcherPath, "utf8")).toBe("original hidden launcher");
    } else {
      await assertRestored();
      expect((await fs.stat(scriptPath)).mode & 0o7777).toBe(originalMode);
    }
    await assertBackups();
    expect(native.run).not.toHaveBeenCalled();
    expect(native.exec.mock.calls.every(([command]) => command[0] === "/Query")).toBe(true);
  },
);

it.each([
  "queued",
  "unknown-state",
  "unknown-process",
  "foreign-registration",
  "foreign-launcher",
  "foreign-partial-publication",
  "registration-without-receipt",
])("retains backups with an incomplete outcome when compensation sees %s", async (failure) => {
  const { args, scriptPath, original, registration, assertBackups } = await fixture();
  let revoked = false;
  const rename = fs.rename;
  if (failure === "foreign-partial-publication") {
    vi.spyOn(fs, "rename").mockImplementation(async (...parameters) => {
      await rename(...parameters);
      if (parameters[1] === scriptPath) {
        await fs.writeFile(scriptPath, "unrelated replacement");
        revoked = true;
      }
    });
  }
  if (failure === "registration-without-receipt") {
    const execute = native.exec.getMockImplementation()!;
    native.exec.mockImplementation(async (command) => {
      const result = await execute(command);
      if (command[0] === "/Create") {
        revoked = true;
      }
      return result;
    });
  }
  native.run.mockImplementation(async () => {
    revoked = true;
    if (failure === "queued") {
      native.probe.mockReturnValue({ status: "found", state: 2, enabled: false });
    }
    if (failure === "unknown-state") {
      native.probe.mockReturnValue({
        status: "unknown",
        detail: "unavailable",
        diagnostic: { kind: "invalid-response" },
      });
    }
    if (failure === "unknown-process") {
      native.runtime.mockResolvedValue({ status: "unknown" });
    }
    if (failure === "foreign-registration") {
      registration.xml = originalXml;
    }
    if (failure === "foreign-launcher") {
      await fs.writeFile(scriptPath, "unrelated replacement");
    }
    return "scheduled-task";
  });
  await expect(installWithCustody(args, () => revoked)).rejects.toMatchObject({
    code: "service-authority-revoked",
    outcome: "recovery-pending",
  });
  await assertBackups();
  expect(await fs.readFile(scriptPath)).not.toEqual(original);
  expect(args.warn).toHaveBeenCalledWith(expect.stringContaining("queued task may still start"));
  expect(native.exec.mock.calls.filter(([command]) => command[0] === "/Create")).toHaveLength(
    failure === "foreign-partial-publication" ? 0 : 1,
  );
  if (failure.startsWith("foreign-")) {
    expect(
      native.exec.mock.calls.some(
        ([command]) => command.includes("/DISABLE") || command[0] === "/End",
      ),
    ).toBe(false);
  }
});

it.each(["publication", "activation"])(
  "leaves transactional repair recovery to its caller after revoked %s",
  async (phase) => {
    const { args, scriptPath, launcherPath, original } = await fixture();
    let revoked = false;
    const written: string[] = [];
    const definitionTransaction: GatewayServiceDefinitionTransactionHooks = {
      assertCurrent: () => {},
      beforeWrite: async () => {},
      filePrepared: async () => {},
      fileWritten: async (file) => {
        written.push(file);
        if (phase === "publication" && file === scriptPath) {
          revoked = true;
        }
      },
      taskPrepared: async () => {},
      taskWritten: async () => {},
    };
    native.run.mockImplementation(async () => {
      revoked = true;
      return "scheduled-task";
    });
    await expect(
      installWithCustody({ ...args, definitionTransaction }, () => revoked),
    ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: undefined });
    expect(await fs.readFile(scriptPath)).not.toEqual(original);
    expect(written).toEqual(phase === "publication" ? [scriptPath] : [scriptPath, launcherPath]);
    expect(native.exec.mock.calls.map(([command]) => command[0])).toEqual(
      phase === "publication" ? [] : ["/Query", "/Create"],
    );
    for (const backup of [
      `${scriptPath}.bak`,
      `${launcherPath}.bak`,
      `${scriptPath}.task.xml.bak`,
    ]) {
      await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(args.warn).not.toHaveBeenCalled();
  },
);

it.each([
  "running",
  "running-disabled",
  "stopped",
  "revival-unconfirmed",
  "revival-denied",
  "disabled-revival-unconfirmed",
])("restores the original Scheduled Task runtime after rollback (%s)", async (scenario) => {
  const enabled = scenario !== "running-disabled" && scenario !== "disabled-revival-unconfirmed";
  const { args, scriptPath, original, registration, assertRestored, assertBackups } =
    await fixture(enabled);
  const originallyRunning = scenario !== "stopped";
  let taskRunning = originallyRunning;
  let taskEnabled = enabled;
  native.probe.mockImplementation(() => ({
    status: "found",
    state: taskRunning ? 4 : 3,
    enabled: taskEnabled,
  }));
  let revoked = false;
  native.run.mockImplementation(async () => {
    revoked = true;
    return "scheduled-task";
  });
  const execute = native.exec.getMockImplementation()!;
  native.exec.mockImplementation(async (command) => {
    if (command[0] === "/Run") {
      // Revival must launch the verified old files and XML under recovery custody.
      assertGatewayServiceUpdateCurrent();
      expect(await fs.readFile(scriptPath)).toEqual(original);
      expect(registration.xml).toBe(originalXml.replace("<Enabled>false", "<Enabled>true"));
      if (scenario === "revival-denied") {
        return { code: 1, stdout: "", stderr: "Access denied" };
      }
      taskRunning = !scenario.endsWith("revival-unconfirmed");
    }
    if (command[0] === "/End") {
      taskRunning = false;
    }
    if (command.includes("/DISABLE")) {
      taskEnabled = false;
    }
    if (command.includes("/ENABLE")) {
      taskEnabled = true;
    }
    return execute(command);
  });
  native.running.mockImplementation(async () => taskRunning);
  const pending = scenario.includes("revival-");
  await expect(installWithCustody(args, () => revoked)).rejects.toMatchObject({
    code: "service-authority-revoked",
    outcome: pending ? "recovery-pending" : "restored",
  });
  await assertRestored();
  await assertBackups();
  expect(native.exec.mock.calls.filter(([command]) => command[0] === "/Run")).toHaveLength(
    originallyRunning ? 1 : 0,
  );
  expect(native.exec.mock.calls.some(([command]) => command.includes("/ENABLE"))).toBe(true);
  expect(taskRunning).toBe(originallyRunning && !pending);
  if (pending) {
    expect(args.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovery did not confirm completion"),
    );
  } else {
    expect(args.warn).not.toHaveBeenCalled();
  }
});
