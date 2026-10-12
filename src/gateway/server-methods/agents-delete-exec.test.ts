import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  captureExecRequestCancellation,
  drainAgentExecProcesses,
} from "../../agents/bash-process-control.js";
import {
  getSession,
  markBackgrounded,
  waitForExecSession,
} from "../../agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../../agents/bash-tools.exec-run.js";
import { runExecProcess } from "../../agents/bash-tools.exec-runtime.js";
import {
  createRunExit,
  runtimeManagedRun,
} from "../../agents/bash-tools.exec-runtime.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { CronService } from "../../cron/service.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import type { SpawnInput } from "../../process/supervisor/types.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { deleteGatewayAgent } from "./agents-delete.js";

const supervisor = vi.hoisted(() => ({ spawn: vi.fn(), cancel: vi.fn() }));

// mock-isolation: Only native spawn and exit are controlled; process and deletion owners are real.
vi.mock("../../process/supervisor/index.js", () => ({ getProcessSupervisor: () => supervisor }));

vi.mock("../../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/shell-env.js")>()),
  getShellPathFromLoginShell: () => null,
}));

afterEach(() => {
  resetProcessRegistryForTests();
  vi.useRealTimers();
  vi.resetAllMocks();
});

function prepareProcess(onCancel?: () => void) {
  const exit = createDeferred<ReturnType<typeof createRunExit>>();
  const cancelled = createDeferred();
  const cancel = vi.fn(() => {
    cancelled.resolve();
    onCancel?.();
  });
  supervisor.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
    ...runtimeManagedRun(input),
    activity: { resultSettled: false, lastOutputAtMs: 1 },
    cancel,
    wait: () => exit.promise,
  }));
  return { exit, cancelled, cancel };
}

function launchOwnedProcess() {
  return runExecProcess({
    agentId: "doomed",
    command: "fixture-service",
    workdir: "/tmp",
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: null,
  });
}

it("drains an independent agent service through exit while preserving another agent and ordinary Stop", async () => {
  await withOpenClawTestState({ label: "agent-delete-exec" }, async (state) => {
    const workspace = state.path("workspace-doomed");
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/witness.txt`, "process still owns its workspace");
    await state.writeConfig({
      agents: {
        ownership: "explicit",
        defaults: { skipBootstrap: true },
        entries: { keeper: { workspace: state.workspaceDir }, doomed: { workspace } },
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const launch = async (agentId: string, cwd: string) => {
      const identity = { runId: `${agentId}-run`, agentId };
      const result = await withExecRequestTurn({ identity }, () =>
        createExecTool({
          ...identity,
          config: getRuntimeConfig(),
          host: "gateway",
          security: "full",
          ask: "off",
          allowBackground: true,
          notifyOnExit: false,
          preparedStoreEnvironment: {},
        }).execute(identity.runId, {
          command: "node --version",
          workdir: cwd,
          background: true,
          timeoutSeconds: 0,
        }),
      );
      const details = result.details;
      if (details.status !== "running") {
        throw new Error(`Expected a running service: ${JSON.stringify(result)}`);
      }
      const session = getSession(details.sessionId);
      if (!session) {
        throw new Error("Service is missing from its process owner");
      }
      return session;
    };
    const doomed = prepareProcess();
    const doomedSession = await launch("doomed", workspace);
    const keeper = prepareProcess();
    const keeperSession = await launch("keeper", state.workspaceDir);
    supervisor.cancel.mockImplementation((id: string) => {
      if (id === doomedSession.id) {
        doomed.cancel();
      }
      if (id === keeperSession.id) {
        keeper.cancel();
      }
    });
    const stop = captureExecRequestCancellation({ agentId: "doomed" });
    expect(stop.cancel()).toBe(false);
    await stop.settle();
    expect(doomed.cancel).not.toHaveBeenCalled();
    const scheduler = createTestGatewayScheduler();
    const cron = new CronService({
      scheduler,
      storePath: state.statePath("cron/jobs.json"),
      cronEnabled: false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const deleting = deleteGatewayAgent(
      "doomed",
      true,
      createDirectChatContext({ cron, getRuntimeConfig }),
    );
    const settled = vi.fn();
    void deleting.then(settled, settled);
    try {
      await awaitGateBeforeSettlement(
        doomed.cancelled.promise,
        deleting,
        "deletion skipped independent exec",
      );
      expect(keeper.cancel).not.toHaveBeenCalled();
      expect(await readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      expect(settled).not.toHaveBeenCalled();
      expect(await fs.readFile(`${workspace}/witness.txt`, "utf8")).toBe(
        "process still owns its workspace",
      );
      doomed.exit.resolve(createRunExit({ reason: "manual-cancel" }));
      await expect(deleting).resolves.toMatchObject({ ok: true, failed: [] });
      await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(keeper.cancel).not.toHaveBeenCalled();
      expect(keeperSession.exited).toBe(false);
    } finally {
      doomed.exit.resolve(createRunExit());
      keeper.exit.resolve(createRunExit());
      await Promise.allSettled([
        deleting,
        waitForExecSession(doomedSession),
        waitForExecSession(keeperSession),
      ]);
      vi.useRealTimers();
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
    }
  });
});

it("rejects later exec cancellation after authority loss while joining the accepted process", async () => {
  let current = true;
  const first = prepareProcess(() => {
    current = false;
  });
  const firstRun = await launchOwnedProcess();
  const second = prepareProcess();
  const secondRun = await launchOwnedProcess();
  supervisor.cancel.mockImplementation((id: string) => {
    if (id === firstRun.session.id) {
      first.cancel();
    }
    if (id === secondRun.session.id) {
      second.cancel();
    }
  });
  const draining = drainAgentExecProcesses("doomed", () => {
    if (!current) {
      throw new Error("deletion authority lost");
    }
  });
  const settled = vi.fn();
  void draining.then(settled, settled);
  try {
    await first.cancelled.promise;
    expect(second.cancel).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    first.exit.resolve(createRunExit({ reason: "manual-cancel" }));
    await expect(draining).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "deletion authority lost" })],
    });
    expect(second.cancel).not.toHaveBeenCalled();
  } finally {
    first.exit.resolve(createRunExit());
    second.exit.resolve(createRunExit());
    await Promise.allSettled([draining, firstRun.promise, secondRun.promise]);
  }
});

it("joins an already exiting process and refuses uncertain cleanup on deletion retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const entered = createDeferred();
  const extinction = createDeferred();
  supervisor.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
    ...runtimeManagedRun(input),
    waitForExtinction: () => {
      entered.resolve();
      return extinction.promise;
    },
  }));
  const run = await launchOwnedProcess();
  markBackgrounded(run.session);
  await entered.promise;
  const draining = drainAgentExecProcesses("doomed", () => {});
  const settled = vi.fn();
  void draining.then(settled, settled);
  try {
    expect(supervisor.cancel).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    extinction.reject(new Error("physical exit could not be confirmed"));
    await expect(draining).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("cleanup could not be confirmed"),
        }),
      ],
    });
    await run.promise;
    await expect(drainAgentExecProcesses("doomed", () => {})).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("cleanup could not be confirmed"),
        }),
      ],
    });
  } finally {
    extinction.resolve();
    await Promise.allSettled([draining, run.promise]);
  }
});
