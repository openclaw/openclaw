import "../test-utils/prepare-compiled-subprocesses.js";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { installScheduledTask } from "./schtasks-install.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { verifyWindowsRegistrationReadiness } from "./schtasks-registration-transition.js";
import { launchFallbackTaskScript } from "./schtasks-runtime.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceDefinitionTransactionHooks,
  WindowsServiceRegistrationKind,
} from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceInstallArgs } from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceInstallationRecovery,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

const native = vi.hoisted(() => ({
  clock: 0,
  command: vi.fn<typeof import("./schtasks-layout.js").readScheduledTaskCommand>(),
  runtime: vi.fn<typeof import("./schtasks-runtime.js").resolveFallbackRuntime>(),
  terminate: vi.fn<typeof import("./schtasks-process.js").terminateScheduledTaskGatewayListeners>(),
  ready:
    vi.fn<typeof import("../cli/daemon-cli/restart-health-probe.js").waitForGatewayHttpReadiness>(),
  spawn: vi.fn<typeof import("../process/spawn-utils.js").spawnWithFallback>(),
  publish: vi.fn<typeof import("./schtasks-install-files.js").publishScheduledTaskFiles>(),
  backup: vi.fn<typeof import("./schtasks-install-files.js").backupScheduledTaskDefinition>(),
  exec: vi.fn<typeof import("./schtasks-exec.js").execSchtasks>(),
  stopTask: vi.fn<typeof import("./schtasks-control.js").stopRegisteredScheduledTask>(),
  runTask: vi.fn<typeof import("./schtasks-control.js").runScheduledTaskOrThrow>(),
  removeStartup: vi.fn<typeof import("./schtasks-runtime.js").removeStartupEntries>(),
}));

vi.mock("./schtasks-layout.js", async (original) => ({
  ...(await original<typeof import("./schtasks-layout.js")>()),
  readScheduledTaskCommand: native.command,
}));
vi.mock("./schtasks-runtime.js", async (original) => ({
  ...(await original<typeof import("./schtasks-runtime.js")>()),
  resolveFallbackRuntime: native.runtime,
  removeStartupEntries: native.removeStartup,
  isScheduledTaskDefinitelyNotRunning: () => false,
}));
vi.mock("./schtasks-process.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process.js")>()),
  terminateScheduledTaskGatewayListeners: native.terminate,
}));
vi.mock("./schtasks-control.js", async (original) => ({
  ...(await original<typeof import("./schtasks-control.js")>()),
  stopRegisteredScheduledTask: native.stopTask,
  runScheduledTaskOrThrow: native.runTask,
}));
vi.mock("./schtasks-exec.js", async (original) => ({
  ...(await original<typeof import("./schtasks-exec.js")>()),
  execSchtasks: native.exec,
}));
vi.mock("./schtasks-state-probe.js", async (original) => ({
  ...(await original<typeof import("./schtasks-state-probe.js")>()),
  probeScheduledTaskExists: () => true,
}));
vi.mock("./schtasks-install-files.js", async (original) => ({
  ...(await original<typeof import("./schtasks-install-files.js")>()),
  publishScheduledTaskFiles: native.publish,
  backupScheduledTaskDefinition: native.backup,
}));
vi.mock("../cli/daemon-cli/restart-health-probe.js", async (original) => ({
  ...(await original<typeof import("../cli/daemon-cli/restart-health-probe.js")>()),
  waitForGatewayHttpReadiness: native.ready,
}));
vi.mock("../process/spawn-utils.js", async (original) => ({
  ...(await original<typeof import("../process/spawn-utils.js")>()),
  spawnWithFallback: native.spawn,
}));
vi.mock("../config/io.runtime.js", async (original) => ({
  ...(await original<typeof import("../config/io.runtime.js")>()),
  createConfigIO: () => ({ readBestEffortConfig: async () => ({}) }),
}));
vi.mock("./gateway-service-probe-hosts.js", async (original) => ({
  ...(await original<typeof import("./gateway-service-probe-hosts.js")>()),
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));
vi.mock("../infra/ports-inspect.js", async (original) => ({
  ...(await original<typeof import("../infra/ports-inspect.js")>()),
  inspectPortUsage: async (port: number) => ({ port, status: "free", listeners: [], hints: [] }),
}));
vi.mock("../utils/sleep.js", async (original) => ({
  ...(await original<typeof import("../utils/sleep.js")>()),
  sleep: async (milliseconds: number) => {
    native.clock += milliseconds;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  native.clock = 0;
  vi.spyOn(Date, "now").mockImplementation(() => native.clock);
});
afterEach(() => vi.restoreAllMocks());

function fixture(kind: WindowsServiceRegistrationKind = "startup", running = true) {
  const env = {
    OPENCLAW_STATE_DIR: "/fixture/windows-registration",
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_GATEWAY_PORT: "19341",
    USERNAME: "operator",
  };
  const previous: GatewayServiceCommandConfig = {
    programArguments: ["/fixture/node.exe", "/fixture/a/index.js", "gateway", "--port", "19341"],
    workingDirectory: "/fixture/workspace",
    environment: env,
    ...(kind === "startup" ? { startupEntryPaths: ["/fixture/Startup/OpenClaw.vbs"] } : {}),
  };
  const candidate: GatewayServiceCommandConfig = {
    ...previous,
    programArguments: ["/fixture/bun.exe", "/fixture/a/index.js", "gateway", "--port", "19341"],
  };
  const events: string[] = [];
  const state: {
    command: GatewayServiceCommandConfig;
    process: "previous" | "candidate" | null;
    revoked: boolean;
  } = { command: previous, process: running ? "previous" : null, revoked: false };
  let recovery: ((restoreDefinition: () => Promise<boolean>) => Promise<boolean>) | undefined;
  const assertCurrent = () => {
    assertGatewayServiceUpdateCurrent();
    if (state.revoked) {
      throw new Error("registration authority revoked");
    }
  };
  const transaction: GatewayServiceDefinitionTransactionHooks = {
    windowsRegistration: kind,
    assertCurrent,
    beforeWrite: async () => assertCurrent(),
    filePrepared: async () => {},
    fileWritten: async () => {},
    taskPrepared: async () => {},
    taskWritten: async () => {},
    registerNativeRecovery: (recover) => {
      expect(recovery).toBeUndefined();
      recovery = recover;
    },
  };
  const args: GatewayServiceInstallArgs = {
    ...candidate,
    env,
    stdout: new PassThrough(),
    definitionTransaction: transaction,
    assertCurrent,
  };
  const context = { env, command: candidate, transaction, assertCurrent };
  native.command.mockImplementation(async () => state.command);
  native.runtime.mockImplementation(async (_env, command) => {
    if (!state.process) {
      return { status: "stopped" };
    }
    const expected = state.process === "previous" ? previous : candidate;
    return command && command.programArguments[0] !== expected.programArguments[0]
      ? { status: "unknown" }
      : { status: "running", pid: state.process === "previous" ? 101 : 202 };
  });
  native.terminate.mockImplementation(async (_env, _context, current, _stop, beforeMutation) => {
    await beforeMutation?.();
    current?.();
    const stopped = state.process ? [state.process === "previous" ? 101 : 202] : [];
    events.push(`stop:${state.process ?? "none"}`);
    state.process = null;
    return stopped;
  });
  native.publish.mockImplementation(async (files, _hooks, beforePublish) => {
    await beforePublish?.();
    expect(state.process).toBeNull();
    expect(files.every((file) => !file.path.includes("Startup"))).toBe(true);
    events.push("publish");
    state.command = candidate;
    return undefined;
  });
  native.spawn.mockImplementation(async (params) => {
    params.assertCurrent?.();
    state.process = params.argv[0] === previous.programArguments[0] ? "previous" : "candidate";
    events.push(`start:${state.process}`);
    return { child: new ChildProcess(), usedFallback: false };
  });
  native.ready.mockImplementation(async () => {
    events.push(`ready:${state.process}`);
    return { healthz: 200, readyz: 200 };
  });
  native.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  native.runTask.mockImplementation(async () => {
    state.process = "candidate";
    events.push("start:candidate");
    return "scheduled-task";
  });
  native.stopTask.mockImplementation(async (params) => {
    await params.beforeMutation?.();
    params.assertCurrent?.();
    events.push(`stop:${state.process ?? "none"}`);
    state.process = null;
    params.onProcessStopped?.();
    params.onEndMutation?.();
    return false;
  });
  native.backup.mockResolvedValue({
    registered: true,
    xml: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
    assertCurrent: async () => assertCurrent(),
    recordStoppedProcess: () => {},
    retainRecovery: () => {},
    recordRegistration: async () => {},
    restore: async (files) => {
      state.process = null;
      const changed = await files.restore();
      if (running) {
        state.process = "previous";
      }
      return changed;
    },
  });
  const restore = vi.fn(async () => {
    events.push("restore");
    const changed = state.command !== previous;
    state.command = previous;
    return changed;
  });
  return {
    args,
    context,
    previous,
    candidate,
    state,
    events,
    restore,
    install: () => installScheduledTask(args),
    recover: () => {
      if (!recovery) {
        throw new Error("Expected captured native recovery");
      }
      return recovery(restore);
    },
  };
}

const withAuthority = <T>(operation: () => Promise<T>) =>
  withGatewayServiceUpdateAuthority(undefined, operation, { updateOwned: true });

it.each(["startup", "scheduled-task"] as const)(
  "replaces %s through one guarded publication and checked readiness",
  async (kind) => {
    const f = fixture(kind);
    f.args.environment = {
      ...f.args.environment,
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "0",
      OPENCLAW_TEST_UNDEFINED: undefined,
      OPENCLAW_TEST_EMPTY: "",
      NODE_OPTIONS: "",
    };
    await withAuthority(f.install);
    expect(f.events).toEqual(["stop:previous", "publish", "start:candidate", "ready:candidate"]);
    expect(native.publish).toHaveBeenCalledOnce();
    expect(
      native.command.mock.calls.every(
        ([, options]) => options?.requireLoaded === true || kind === "scheduled-task",
      ),
    ).toBe(true);
    expect(native.removeStartup).not.toHaveBeenCalled();
    if (kind === "startup") {
      const environment = native.spawn.mock.calls[0]?.[0].options?.env;
      expect(environment).not.toHaveProperty("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER", "0");
      expect(environment).not.toHaveProperty("OPENCLAW_TEST_UNDEFINED");
      expect(environment).not.toHaveProperty("OPENCLAW_TEST_EMPTY");
      expect(environment).toHaveProperty("NODE_OPTIONS", "");
      expect(native.exec).not.toHaveBeenCalled();
      expect(native.runTask).not.toHaveBeenCalled();
      expect(native.stopTask).not.toHaveBeenCalled();
      expect(native.backup).not.toHaveBeenCalled();
      expect(native.publish.mock.calls[0]?.[0].map((file) => file.path)).toEqual([
        resolveTaskScriptPath(f.args.env),
      ]);
    } else {
      expect(native.exec.mock.calls.some(([argv]) => argv[0] === "/Create")).toBe(true);
    }
  },
);

it.each(["startup", "scheduled-task"] as const)(
  "does not accept a resolved but unready HTTP result for %s",
  async (kind) => {
    const f = fixture(kind);
    native.ready.mockImplementation(async () => {
      native.clock += 600_000;
      return { healthz: 200, readyz: 503 };
    });
    await expect(withAuthority(f.install)).rejects.toThrow("/readyz=503");
  },
);

it("keeps cold Startup observations pending until HTTP and process ownership agree", async () => {
  const f = fixture();
  f.state.command = f.candidate;
  f.state.process = "candidate";
  const observations: GatewayServiceRuntime[] = [
    { status: "unknown" },
    { status: "stopped" },
    { status: "running", pid: 202 },
    { status: "running", pid: 202 },
  ];
  native.runtime.mockImplementation(async () => observations.shift() ?? { status: "unknown" });
  await withAuthority(() => verifyWindowsRegistrationReadiness(f.context));
  expect(native.clock).toBe(1_000);
  expect(native.terminate).not.toHaveBeenCalled();
});

it.each(["kind", "command", "authority"] as const)(
  "refuses %s drift after HTTP readiness before installation can return",
  async (drift) => {
    const f = fixture();
    native.ready.mockImplementation(async () => {
      if (drift === "kind") {
        f.state.command = { ...f.candidate, startupEntryPaths: undefined };
      } else if (drift === "command") {
        f.state.command = { ...f.candidate, programArguments: ["foreign"] };
      } else {
        f.state.revoked = true;
      }
      return { healthz: 200, readyz: 200 };
    });
    await expect(withAuthority(f.install)).rejects.toThrow(/changed|revoked|differs/);
  },
);

it.each([true, false])(
  "settles the candidate and centrally restores Startup once (previously running=%s)",
  async (running) => {
    const f = fixture("startup", running);
    native.ready.mockImplementation(async () => {
      if (f.state.process === "candidate") {
        native.clock += 600_000;
        return { healthz: 200, readyz: 503 };
      }
      f.events.push("ready:previous");
      return { healthz: 200, readyz: 200 };
    });
    await withAuthority(async () => {
      await expect(f.install()).rejects.toThrow("/readyz=503");
      await f.recover();
    });
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.events.indexOf("stop:candidate")).toBeLessThan(f.events.indexOf("restore"));
    expect(f.state.process).toBe(running ? "previous" : null);
    expect(f.events.includes("ready:previous")).toBe(running);
    expect(native.exec).not.toHaveBeenCalled();
  },
);

it.each(
  (["startup", "scheduled-task"] as const).flatMap((kind) =>
    [false, true].flatMap((updateOwned) =>
      [false, true].map((revoked) => ({ kind, updateOwned, revoked })),
    ),
  ),
)(
  "retains outer recovery custody after the $kind installer closes (update=$updateOwned, revoked=$revoked)",
  async ({ kind, updateOwned, revoked }) => {
    const f = fixture(kind);
    const failure = new Error("synthetic sharing violation before publication");
    let outerCurrent = true;
    native.publish.mockImplementation(async (_files, _hooks, beforePublish) => {
      await beforePublish?.();
      outerCurrent = !revoked;
      throw failure;
    });
    const recover = vi.fn(async () => {
      // The service adapter's guard expires before central reconciliation catches failure.
      expect(() => f.args.assertCurrent?.()).toThrow("Native service authority has closed");
      return f.recover();
    });
    const result = withGatewayServiceUpdateAuthority(
      () => {
        if (!outerCurrent) {
          throw new Error("outer recovery custody revoked");
        }
      },
      (assertOuter) =>
        withGatewayServiceInstallationRecovery(
          () =>
            withGatewayServiceUpdateAuthority(
              assertOuter,
              async (assertInstaller) => {
                f.args.assertCurrent = assertInstaller;
                await f.install();
              },
              { updateOwned: false, assertRecoveryCurrent: assertOuter },
            ),
          recover,
        ),
      { updateOwned },
    );
    if (revoked) {
      await expect(result).rejects.toMatchObject({
        code: "service-authority-revoked",
        outcome: "recovery-pending",
      });
      expect(recover).not.toHaveBeenCalled();
      expect(f.restore).not.toHaveBeenCalled();
      expect(f.state.process).toBeNull();
      expect(f.events).not.toContain("ready:previous");
    } else {
      await expect(result).rejects.toBe(failure);
      expect(recover).toHaveBeenCalledOnce();
      expect(f.restore).toHaveBeenCalledOnce();
      expect(f.state.command).toBe(f.previous);
      expect(f.state.process).toBe("previous");
      expect(f.events).toContain("ready:previous");
    }
    expect(() => f.args.assertCurrent?.()).toThrow("Native service authority has closed");
  },
);

it("rechecks the shared termination guard before changing an owned Startup process", async () => {
  const f = fixture();
  const terminate = native.terminate.getMockImplementation();
  if (!terminate) {
    throw new Error("Expected the fixture's guarded termination implementation");
  }
  native.terminate.mockImplementation(async (...args) => {
    f.state.revoked = true;
    return await terminate(...args);
  });
  await expect(withAuthority(f.install)).rejects.toThrow("revoked");
  expect(f.state.process).toBe("previous");
  expect(f.events).not.toContain("publish");
});

it("does not admit an unguarded update-owned Startup spawn", async () => {
  const f = fixture();
  await expect(
    withAuthority(() => launchFallbackTaskScript(f.args.env, f.candidate)),
  ).rejects.toThrow("startup fallback is unsupported");
  expect(native.spawn).not.toHaveBeenCalled();
});

it("awaits the Startup publication guard before spawning", async () => {
  const f = fixture();
  const admitted = createDeferredCore();
  const entered = createDeferredCore();
  f.context.transaction.beforeWrite = async () => {
    entered.resolve();
    await admitted.promise;
  };
  await withAuthority(async () => {
    const launch = launchFallbackTaskScript(
      f.args.env,
      f.candidate,
      undefined,
      f.context.transaction,
    );
    await awaitGateBeforeSettlement(entered.promise, launch, "Startup spawn guard was not reached");
    expect(native.spawn).not.toHaveBeenCalled();
    admitted.resolve();
    await launch;
  });
  expect(native.spawn).toHaveBeenCalledOnce();
});
