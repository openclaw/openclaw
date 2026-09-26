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
}));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.exec }));
vi.mock("./schtasks-control.js", async (original) => ({
  ...(await original<typeof import("./schtasks-control.js")>()),
  runScheduledTaskOrThrow: native.run,
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
vi.mock("./schtasks-state-probe.js", () => ({ probeScheduledTaskState: native.probe }));
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
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (revoked) {
          throw new Error("Doctor custody revoked");
        }
      },
      () => installScheduledTask(args),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({
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

    await expect(
      withGatewayServiceUpdateAuthority(
        () => {
          if (revoked) {
            throw new Error("Doctor custody revoked");
          }
        },
        () => installScheduledTask(args),
        { updateOwned: false, assertRecoveryCurrent: () => {} },
      ),
    ).rejects.toMatchObject({
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
      expect((await fs.stat(scriptPath)).mode & 0o7777).toBe(0o640);
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
    if (failure === "foreign-registration") {
      registration.xml = originalXml;
    }
    if (failure === "foreign-launcher") {
      await fs.writeFile(scriptPath, "unrelated replacement");
    }
    return "scheduled-task";
  });
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
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (revoked) {
          throw new Error("Doctor custody revoked");
        }
      },
      () => installScheduledTask(args),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: "recovery-pending" });
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
      withGatewayServiceUpdateAuthority(
        () => {
          if (revoked) {
            throw new Error("Doctor custody revoked");
          }
        },
        () => installScheduledTask({ ...args, definitionTransaction }),
        { updateOwned: false, assertRecoveryCurrent: () => {} },
      ),
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
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (revoked) {
          throw new Error("Doctor custody revoked");
        }
      },
      () => installScheduledTask(args),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({
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
