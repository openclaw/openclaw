import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import * as launchctl from "../../daemon/launchd-exec.js";
import { startLaunchAgent } from "../../daemon/launchd-lifecycle.js";
import { bootstrapLaunchAgentOrThrow } from "../../daemon/launchd-runtime.js";
import * as launchdSystem from "../../daemon/launchd-system.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  startScheduledTask,
} from "../../daemon/schtasks-control.js";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import * as taskLayout from "../../daemon/schtasks-layout.js";
import * as taskRuntime from "../../daemon/schtasks-runtime.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import { startSystemdService } from "../../daemon/systemd-lifecycle.js";
import * as systemdScope from "../../daemon/systemd-scope.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";

const nativeSpawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("unexpected native spawn");
  }),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: nativeSpawn,
}));
const fixture = useExecutorFixture("native-start-fence-");
let root: string;
let control: string;
const success = { stdout: "", stderr: "", code: 0, termination: "exit" as const };
beforeEach(() => {
  nativeSpawn.mockClear();
  ({ root, control } = fixture());
});
function revoke() {
  const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
  try {
    db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
      "replaced",
      root,
    );
  } finally {
    db.close();
  }
}
function serviceArgs(fence: UpdateRecoveryFence) {
  return {
    stdout: new PassThrough(),
    env: { HOME: root },
    assertCurrent: () => fence.assertCurrent(),
  };
}
function owned(operation: (args: ReturnType<typeof serviceArgs>) => Promise<unknown>) {
  return withUpdateCommandExecutor(randomUUID(), async (executor) =>
    operation(serviceArgs(await executor.enter(root))),
  );
}
function expectRevoked(operation: Parameters<typeof owned>[0]) {
  return expect(owned(operation)).rejects.toThrow(/executor|ownership/i);
}
function mockLaunchctl(
  respond: (command: string, calls: string[]) => Promise<typeof success> | typeof success,
) {
  const calls: string[] = [];
  vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
    calls.push(args[0]!);
    return respond(args[0]!, calls);
  });
  return calls;
}

it.each(["user", "system", "reset-failed"] as const)(
  "refuses systemd start after %s revokes its real executor",
  async (at) => {
    vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockImplementation(async () => {
      if (at !== "reset-failed") {
        await Promise.resolve();
        revoke();
      }
      return {
        scope: at === "system" ? "system" : "user",
        unitName: "openclaw-gateway.service",
        unitPath: path.join(root, "gateway.service"),
      };
    });
    vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue();
    vi.spyOn(systemdScope, "assertNoSystemGatewayOwnershipForActivation").mockResolvedValue();
    if (at !== "reset-failed") {
      vi.spyOn(process, "geteuid").mockReturnValue(0);
    }
    const native = vi.spyOn(systemdExec, "execSystemctl").mockResolvedValue(success);
    const calls: string[] = [];
    vi.spyOn(systemdExec, "execSystemctlUser").mockImplementation(async (_env, args) => {
      calls.push(args[0]!);
      if (args[0] === "reset-failed") {
        await Promise.resolve();
        revoke();
      }
      return success;
    });
    await expectRevoked(startSystemdService);
    expect(native).not.toHaveBeenCalled();
    expect(calls).toEqual(at === "reset-failed" ? ["reset-failed"] : []);
  },
);

it.each(["inspection", "enable", "not-loaded", "bootstrap"])(
  "refuses launchd start after %s revokes its real executor",
  async (at) => {
    vi.spyOn(launchdSystem, "assertNoSystemLaunchDaemonOwnership").mockImplementation(async () => {
      await Promise.resolve();
      if (at === "inspection") {
        revoke();
      }
    });
    const calls = mockLaunchctl(async (command) => {
      await Promise.resolve();
      if ((at === "enable" || at === "bootstrap") && command === "enable") {
        revoke();
      }
      if (at === "not-loaded" && command === "kickstart") {
        revoke();
        return { ...success, code: 1, stderr: "Could not find service" };
      }
      return success;
    });
    await expectRevoked(
      at === "bootstrap"
        ? ({ assertCurrent }) =>
            bootstrapLaunchAgentOrThrow({
              domain: "gui/501",
              serviceTarget: "gui/501/test",
              plistPath: path.join(root, "gateway.plist"),
              actionHint: "test",
              assertCurrent,
            })
        : startLaunchAgent,
    );
    expect(calls).toEqual(
      at === "inspection" ? [] : at === "not-loaded" ? ["enable", "kickstart"] : ["enable"],
    );
  },
);

it("preserves separately restored launchd enable policy across bootstrap", async () => {
  vi.spyOn(launchdSystem, "assertNoSystemLaunchDaemonOwnership").mockResolvedValue();
  const calls = mockLaunchctl((command, history) => {
    return command === "kickstart" && history.length === 1
      ? { ...success, code: 1, stderr: "Could not find service" }
      : success;
  });
  await owned((args) => startLaunchAgent({ ...args, preserveAutoStart: true }));
  expect(calls).toEqual(["kickstart", "print-disabled", "bootstrap", "kickstart"]);
});

it("refuses task start after registration inspection revokes its real executor", async () => {
  vi.spyOn(taskRuntime, "assertSchtasksAvailable").mockResolvedValue();
  vi.spyOn(taskRuntime, "isRegisteredScheduledTask").mockImplementation(async () => {
    await Promise.resolve();
    revoke();
    return true;
  });
  vi.spyOn(taskRuntime, "readScheduledTaskRuntime").mockResolvedValue({ status: "running" });
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expectRevoked(startScheduledTask);
  expect(native).not.toHaveBeenCalled();
});

it("refuses task enable after preparation revokes its real executor", async () => {
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expectRevoked(({ env, assertCurrent }) =>
    resumeScheduledTaskAutoStartAfterUpdate(env, {
      beforeMutation: async () => {
        await Promise.resolve();
        revoke();
      },
      assertCurrent,
    }),
  );
  expect(native).not.toHaveBeenCalled();
});

it("refuses login-item spawn when command inspection revokes the real executor", async () => {
  vi.spyOn(taskLayout, "readScheduledTaskCommand").mockImplementation(async () => {
    await Promise.resolve();
    revoke();
    return { programArguments: [process.execPath, "gateway-test.js"] };
  });
  await expectRevoked(({ env, stdout, assertCurrent }) =>
    taskRuntime.startStartupEntry(env, stdout, undefined, assertCurrent),
  );
  expect(nativeSpawn).not.toHaveBeenCalled();
});
it("refuses login-item fallback for the captured registered task", async () => {
  vi.spyOn(taskRuntime, "assertSchtasksAvailable").mockResolvedValue();
  vi.spyOn(taskRuntime, "isRegisteredScheduledTask").mockResolvedValue(false);
  vi.spyOn(taskRuntime, "isStartupEntryInstalled").mockResolvedValue(true);
  const start = vi.spyOn(taskRuntime, "startStartupEntry").mockResolvedValue();
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expect(
    owned((args) => startScheduledTask({ ...args, preserveAutoStart: true })),
  ).rejects.toThrow("Captured Scheduled Task registration");
  expect(start).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});
