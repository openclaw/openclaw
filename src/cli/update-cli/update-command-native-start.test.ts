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
function owned(operation: (fence: UpdateRecoveryFence) => Promise<void>) {
  return withUpdateCommandExecutor(randomUUID(), async (executor) =>
    operation(await executor.enter(root)),
  );
}
function serviceArgs(fence: UpdateRecoveryFence) {
  return {
    stdout: new PassThrough(),
    env: { HOME: root },
    assertCurrent: () => fence.assertCurrent(),
  };
}
function expectRevoked(operation: (fence: UpdateRecoveryFence) => Promise<void>) {
  return expect(owned(operation)).rejects.toThrow(/executor|ownership/i);
}
function mockSystemd(scope: "user" | "system" = "user", inspect = async () => {}) {
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockImplementation(async () => {
    await inspect();
    return {
      scope,
      unitName: "openclaw-gateway.service",
      unitPath: path.join(root, "gateway.service"),
    };
  });
  vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue();
  vi.spyOn(systemdScope, "assertNoSystemGatewayOwnershipForActivation").mockResolvedValue();
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

it.each(["user", "system"] as const)(
  "refuses systemd %s start after scope inspection revokes its real executor",
  async (scope) => {
    mockSystemd(scope, async () => {
      await Promise.resolve();
      revoke();
    });
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const native = vi.spyOn(systemdExec, "execSystemctl").mockResolvedValue(success);
    const user = vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue(success);
    await expectRevoked(async (fence) => startSystemdService(serviceArgs(fence)));
    expect(native).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
  },
);

it("refuses systemd start after reset-failed revokes its real executor", async () => {
  mockSystemd();
  const calls: string[] = [];
  vi.spyOn(systemdExec, "execSystemctlUser").mockImplementation(async (_env, args) => {
    calls.push(args[0]!);
    if (args[0] === "reset-failed") {
      await Promise.resolve();
      revoke();
    }
    return success;
  });
  await expectRevoked(async (fence) => startSystemdService(serviceArgs(fence)));
  expect(calls).toEqual(["reset-failed"]);
});

it.each(["inspection", "enable", "not-loaded"])(
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
      if (at === "enable" && command === "enable") {
        revoke();
      }
      if (at === "not-loaded" && command === "kickstart") {
        revoke();
        return { ...success, code: 1, stderr: "Could not find service" };
      }
      return success;
    });
    await expectRevoked(async (fence) => startLaunchAgent(serviceArgs(fence)));
    expect(calls).toEqual(
      at === "inspection" ? [] : at === "enable" ? ["enable"] : ["enable", "kickstart"],
    );
  },
);

it("refuses bootstrap after enable revokes the real executor", async () => {
  const calls = mockLaunchctl(async () => {
    await Promise.resolve();
    revoke();
    return success;
  });
  await expectRevoked(async (fence) => {
    await bootstrapLaunchAgentOrThrow({
      domain: "gui/501",
      serviceTarget: "gui/501/test",
      plistPath: path.join(root, "gateway.plist"),
      actionHint: "test",
      assertCurrent: () => fence.assertCurrent(),
    });
  });
  expect(calls).toEqual(["enable"]);
});

it("preserves separately restored launchd enable policy across bootstrap", async () => {
  vi.spyOn(launchdSystem, "assertNoSystemLaunchDaemonOwnership").mockResolvedValue();
  const calls = mockLaunchctl((command, history) => {
    return command === "kickstart" && history.length === 1
      ? { ...success, code: 1, stderr: "Could not find service" }
      : success;
  });
  await owned(async (fence) =>
    startLaunchAgent({ ...serviceArgs(fence), preserveAutoStart: true }),
  );
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
  await expectRevoked(async (fence) => startScheduledTask(serviceArgs(fence)));
  expect(native).not.toHaveBeenCalled();
});

it("refuses task enable after preparation revokes its real executor", async () => {
  const native = vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(success);
  await expectRevoked(async (fence) => {
    await resumeScheduledTaskAutoStartAfterUpdate(
      { HOME: root },
      {
        beforeMutation: async () => {
          await Promise.resolve();
          revoke();
        },
        assertCurrent: () => fence.assertCurrent(),
      },
    );
  });
  expect(native).not.toHaveBeenCalled();
});

it("refuses login-item spawn when command inspection revokes the real executor", async () => {
  vi.spyOn(taskLayout, "readScheduledTaskCommand").mockImplementation(async () => {
    await Promise.resolve();
    revoke();
    return { programArguments: [process.execPath, "gateway-test.js"] };
  });

  await expectRevoked(async (fence) =>
    taskRuntime.startStartupEntry({ HOME: root }, new PassThrough(), undefined, () =>
      fence.assertCurrent(),
    ),
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
    owned(async (fence) => startScheduledTask({ ...serviceArgs(fence), preserveAutoStart: true })),
  ).rejects.toThrow("Captured Scheduled Task registration");
  expect(start).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});
