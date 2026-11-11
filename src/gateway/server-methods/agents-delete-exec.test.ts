import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
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
import { runExecFixture } from "../../agents/bash-tools.exec-fixture.test-support.js";
import { createExecTool } from "../../agents/bash-tools.exec-run.js";
import {
  createRunExit,
  runtimeManagedRun,
} from "../../agents/bash-tools.exec-runtime.test-support.js";
import { fullGatewayExec } from "../../agents/bash-tools.lifecycle.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import type { SpawnInput } from "../../process/supervisor/types.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  configureDeletionAgents,
  createDeletionCron,
} from "./agents-delete.fixture.test-support.js";
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

const launchOwnedProcess = () => runExecFixture({ agentId: "doomed", command: "fixture-service" });

function routeCancellation(...processes: Array<{ id: string; cancel: () => void }>) {
  supervisor.cancel.mockImplementation((id: string) => {
    processes.find((process) => process.id === id)?.cancel();
  });
}

it("drains an independent agent service through exit while preserving another agent and ordinary Stop", async () =>
  withOpenClawTestState({ label: "agent-delete-exec" }, async (state) => {
    const workspace = state.path("workspace-doomed");
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/witness.txt`, "owned");
    await configureDeletionAgents(state, workspace, { skipBootstrap: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const launch = async (agentId: string, cwd: string) => {
      const identity = { runId: `${agentId}-run`, agentId };
      const { details } = await withExecRequestTurn({ identity }, () =>
        createExecTool({
          ...identity,
          config: getRuntimeConfig(),
          ...fullGatewayExec,
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
      assert(details.status === "running", "Expected a running service");
      const session = getSession(details.sessionId);
      assert(session, "Service is missing from its process owner");
      return session;
    };
    const doomed = prepareProcess();
    const doomedSession = await launch("doomed", workspace);
    const keeper = prepareProcess();
    const keeperSession = await launch("keeper", state.workspaceDir);
    routeCancellation(
      { id: doomedSession.id, cancel: doomed.cancel },
      { id: keeperSession.id, cancel: keeper.cancel },
    );
    const stop = captureExecRequestCancellation({ agentId: "doomed" });
    expect(stop.cancel()).toBe(false);
    await stop.settle();
    expect(doomed.cancel).not.toHaveBeenCalled();
    const { stop: stopCron, context } = createDeletionCron(state);
    const deleting = deleteGatewayAgent("doomed", true, context);
    const settled = vi.fn();
    void deleting.then(settled, settled);
    try {
      await awaitGateBeforeSettlement(doomed.cancelled.promise, deleting, "exec skipped");
      expect(keeper.cancel).not.toHaveBeenCalled();
      expect(await readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      expect(settled).not.toHaveBeenCalled();
      expect(await fs.readFile(`${workspace}/witness.txt`, "utf8")).toBe("owned");
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
      await stopCron();
    }
  }));

it("rejects later exec cancellation after authority loss while joining the accepted process", async () => {
  let current = true;
  const first = prepareProcess(() => {
    current = false;
  });
  const firstRun = await launchOwnedProcess();
  const second = prepareProcess();
  const secondRun = await launchOwnedProcess();
  routeCancellation(
    { id: firstRun.session.id, cancel: first.cancel },
    { id: secondRun.session.id, cancel: second.cancel },
  );
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
  const uncertainCleanup = {
    errors: [
      expect.objectContaining({
        message: expect.stringContaining("cleanup could not be confirmed"),
      }),
    ],
  };
  const settled = vi.fn();
  void draining.then(settled, settled);
  try {
    expect(supervisor.cancel).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    extinction.reject(new Error("physical exit could not be confirmed"));
    await expect(draining).rejects.toMatchObject(uncertainCleanup);
    await run.promise;
    await expect(drainAgentExecProcesses("doomed", () => {})).rejects.toMatchObject(
      uncertainCleanup,
    );
  } finally {
    extinction.resolve();
    await Promise.allSettled([draining, run.promise]);
  }
});
