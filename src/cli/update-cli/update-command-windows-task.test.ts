import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate as resumeAutoStart,
  suspendScheduledTaskAutoStartForUpdate as suspendAutoStart,
} from "../../daemon/schtasks-control.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  withCliCommandCleanup,
  withCliProcessScope,
  type CliHarnessCleanup,
} from "../runtime-cleanup-scope.js";
import { waitForCliSignalExit } from "../signal-exit-barrier.js";
import { expectNoCalls } from "./update-boundary.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

vi.mock("../../daemon/schtasks-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks-control.js")>()),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn(),
  suspendScheduledTaskAutoStartForUpdate: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

function recovery(
  options: Parameters<typeof createWindowsTaskAutoStartRecovery>[0] = { serviceEnv: {} },
) {
  return createWindowsTaskAutoStartRecovery({ alreadySuspended: true, ...options });
}

function mockMutation(
  command: typeof suspendAutoStart,
  afterDispatch: () => void | Promise<void> = () => {},
  inspect?: (options: Parameters<typeof suspendAutoStart>[1]) => void,
) {
  vi.mocked(command).mockImplementationOnce(async (_env, options) => {
    inspect?.(options);
    await options?.beforeMutation?.();
    const pending = afterDispatch();
    if (pending) {
      await pending;
    }
    return true;
  });
}

const executorFixture = useExecutorFixture("windows-task-");

async function rebindExecutor(
  store: ReturnType<typeof createManagedHandoffLeaseStore>,
  root: string,
) {
  const original = store.read(root);
  if (original.kind !== "current") {
    throw new Error("missing actual executor");
  }
  await Promise.resolve();
  expect(store.bind(original.lease, process.pid)).not.toBeNull();
}

it.each(["inspection", "enable"] as const)("settles restoration blocked in %s", async (phase) => {
  const entered = createDeferred();
  const released = createDeferred();
  const actions: string[] = [];
  const hold = async () => {
    entered.resolve();
    await released.promise;
  };
  mockMutation(resumeAutoStart, async () => {
    actions.push("enable");
    if (phase === "enable") {
      await hold();
    }
  });
  if (phase === "enable") {
    mockMutation(
      suspendAutoStart,
      () => {
        actions.push("disable");
      },
      (options) => {
        expect(options?.restoreOnFailure).toBe(false);
      },
    );
  }
  const task = recovery({
    serviceEnv: {},
    assertCurrentService: phase === "inspection" ? hold : undefined,
  });
  const restoration = task.restore(true);
  const restored =
    phase === "inspection"
      ? expect(restoration).rejects.toThrow("restoration authority has closed")
      : expect(restoration).resolves.toBeUndefined();
  await entered.promise;
  const settled = task.complete(false);
  if (phase === "enable") {
    await Promise.resolve();
    expect(actions).toEqual(["enable"]);
  }
  released.resolve();
  await restored;
  await settled;
  if (phase === "inspection") {
    await task.restore(true);
    expect(() => task.assertRecoveryCurrent()).toThrow("authority has closed or transferred");
    expectNoCalls(suspendAutoStart);
  }
  expect(actions).toEqual(phase === "enable" ? ["enable", "disable"] : []);
});

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
});

it("refuses caller recovery after transferring native task ownership", async () => {
  vi.mocked(suspendAutoStart).mockClear();
  const task = recovery();
  try {
    task.assertRecoveryCurrent();
    task.handoff(async () => {});
    expect(() => task.assertRecoveryCurrent()).toThrow("authority has closed or transferred");
  } finally {
    await task.complete(true);
  }
  expectNoCalls(suspendAutoStart);
});

it("refuses native compensation after its original live executor changes during inspection", async () => {
  const { root } = executorFixture();
  const actions: string[] = [];
  const store = createManagedHandoffLeaseStore();
  mockMutation(resumeAutoStart, () => {
    actions.push("enable");
  });
  mockMutation(suspendAutoStart, () => {
    actions.push("disable");
  });
  let failure: unknown;
  await expect(
    withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      let compensating = false;
      const task = recovery({
        serviceEnv: {},
        assertCurrent: fence.assertCurrent,
        assertCurrentService: async () => {
          if (!compensating) {
            return;
          }
          await rebindExecutor(store, root);
        },
      });
      try {
        await task.restore(true);
        compensating = true;
        failure = await task.complete(false).catch((error: unknown) => error);
        expect(() => task.assertRecoveryCurrent()).toThrow(/executor/);
      } finally {
        await task.complete(false);
      }
    }),
  ).rejects.toThrow(/executor/);
  expect(String(failure)).toMatch(/executor/);
  expect(actions).toEqual(["enable"]);
});

it("retains the native failure when interrupted cleanup also loses its executor", async () => {
  const { root } = executorFixture();
  const exited = vi.fn<typeof process.exit>();
  vi.spyOn(process, "exit").mockImplementation(exited);
  const listeners = process.listeners("SIGINT");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const store = createManagedHandoffLeaseStore();
  const nativeFailure = new Error("native disable failed after dispatch");
  mockMutation(resumeAutoStart);
  mockMutation(suspendAutoStart, async () => {
    await rebindExecutor(store, root);
    throw nativeFailure;
  });
  let failure: unknown;
  let resources: CliHarnessCleanup["pluginResources"];
  await expect(
    withCliProcessScope(() =>
      withCliCommandCleanup(false, (cleanup) => {
        resources = cleanup?.pluginResources;
        return withUpdateCommandExecutor(run.runId, async (executor) => {
          const executorFence = await executor.enter(root);
          const recoveryListeners = process.listeners("SIGINT");
          const task = recovery({
            serviceEnv: env,
            assertCurrent: executorFence.assertCurrent,
            updateRun: { runId: run.runId, env, executorFence },
          });
          try {
            await task.restore(true);
            const onSignal = process
              .listeners("SIGINT")
              .find((listener) => !recoveryListeners.includes(listener));
            if (!onSignal) {
              throw new Error("missing owned signal handler");
            }
            onSignal("SIGINT");
            expect(process.exitCode).toBe(previousExitCode);
            expect(exited).not.toHaveBeenCalled();
            failure = await task.complete(false).catch((error: unknown) => error);
          } finally {
            await task.complete(false);
          }
        });
      }),
    ),
  ).rejects.toThrow(/executor/);
  expect(await waitForCliSignalExit()).toBe(130);
  await resources?.release();
  expect(process.exitCode).toBe(130);
  expect(exited).not.toHaveBeenCalled();
  expect(failure).toMatchObject({ errors: expect.arrayContaining([nativeFailure]) });
  expect(getUpdateRun(run.runId, { env })).toEqual(run);
  expect(process.listeners("SIGINT")).toEqual(listeners);
});
