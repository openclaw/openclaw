import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { prepareSessionEventTargetForHost } from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import {
  CREATOR,
  SESSION,
  SESSION_ID,
  stateDir,
  createCronFixture,
  createCreatorTransportTools,
  inRun,
  installRequesterCronAuthorityTestHooks,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  enqueueAutomationSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { isCronReplyOperationWaitingForIdle } from "./active-jobs.js";
import { isCronExecutionIdle } from "./execution-idle.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { runCronSessionTurn } from "./session-run.js";
import * as executionBinding from "./store/run-receipt-execution-binding.js";
import type { CronRunReceiptDatabase } from "./store/run-receipt-read.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";

// mock-isolation: Keep real admission and filesystem authority while replacing model inference at the runner boundary.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));

installRequesterCronAuthorityTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Exercise authority with the real reply runtime already transformed, as ordinary reply suites do.
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply.js"),
]);
beforeEach(() => {
  runEmbeddedAgentMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
});

it.each(["own", "foreign", "operator"] as const)(
  "preserves scheduled %s workspace authority through ordinary reply execution",
  async (scenario) => {
    const foreignWorkspace = tempDirs.make("session-automation-foreign-");
    const foreignKey = "agent:main:dashboard:another-person";
    const targetKey = scenario === "own" ? SESSION : foreignKey;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          workspace: stateDir,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: stateDir } },
      },
      plugins: { enabled: false },
      skills: { load: { watch: false } },
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "read", "write"], fs: { workspaceOnly: true } },
    };
    setRuntimeConfigSnapshot(config);
    await fs.writeFile(path.join(stateDir, "sentinel.txt"), "OWN_WORKSPACE");
    await fs.writeFile(path.join(foreignWorkspace, "sentinel.txt"), "FOREIGN_WORKSPACE");
    for (const [sessionKey, sessionId, workspace, creator] of [
      [SESSION, SESSION_ID, stateDir, CREATOR],
      [
        foreignKey,
        "foreign-conversation",
        foreignWorkspace,
        { type: "human", source: "profile", id: "another-person" } as const,
      ],
    ] as const) {
      replaceSessionEntrySync(
        { sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          lifecycleRevision: sessionId,
          spawnedCwd: workspace,
          createdActor: creator,
        },
      );
    }
    const creator = createCronFixture(undefined, config);
    const definition = {
      name: `Session workspace ${scenario}`,
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: `session:${targetKey}`,
      payload: { kind: "agentTurn", message: "Read sentinel.txt", toolsAllow: ["read"] },
      delivery: { mode: "none" },
    };
    if (scenario === "operator") {
      const respond = vi.fn();
      await expectDefined(
        cronHandlers["cron.add"],
        "cron.add",
      )({
        req: { type: "req", id: "operator-create", method: "cron.add", params: definition },
        params: definition,
        respond,
        context: creator.context,
        client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    } else {
      await inRun("session-workspace-creator", undefined, async (_identity, admitted) => {
        bindGatewayContextResolver(admitted, () => creator.context);
        try {
          const tools = await createCreatorTransportTools({
            transport: "embedded",
            config,
            admitted,
            senderIsOwner: true,
          });
          await expect(
            tools.invoke("read", { path: path.join(foreignWorkspace, "sentinel.txt") }),
          ).rejects.toThrow(/outside|sandbox root|escapes/i);
          await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: definition });
        } finally {
          clearGatewayContextResolver(admitted);
        }
      });
    }
    const job = expectDefined((await creator.read())[0], "persisted job");
    const reads: string[] = [];
    runEmbeddedAgentMock.mockImplementation(async (params) => {
      const admitted = await expectDefined(
        params.preparedRunAdmission,
        "scheduled admission",
      ).admit("gateway", params.runId);
      await params.onExecutionStarted?.();
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      params.onExecutionPhase?.({ phase: "model_call_started" });
      if (scenario !== "foreign") {
        expect(admitted.admissionSource).toBe(
          scenario === "operator" ? "operator-schedule" : "requester-schedule",
        );
      }
      return withGatewayToolCallerIdentity(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: targetKey,
        }),
        async () => {
          const tools = createOpenClawCodingTools({
            config: params.config,
            agentId: "main",
            sessionKey: targetKey,
            sessionId: params.sessionId,
            runId: params.runId,
            operationalRunInstance: admitted.operationalRunInstance,
            workspaceDir: params.workspaceDir,
            cwd: params.cwd,
            runtimeToolAllowlist: params.toolsAllow,
            scheduledToolPolicy: params.scheduledToolPolicy,
            toolConstructionPlan: {
              includeBaseCodingTools: true,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: false,
            },
          });
          const read = expectDefined(
            tools.find((tool) => tool.name === "read"),
            "read tool",
          );
          reads.push(
            JSON.stringify(await read.execute("scheduled-read", { path: "sentinel.txt" })),
          );
          return { payloads: [{ text: "Read complete" }], meta: { durationMs: 1 } };
        },
      );
    });
    const execution = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: path.join(stateDir, "cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("Expected ordinary session execution");
      }),
      runSessionEvent: (request) =>
        runCronSessionTurn({ ...request, cfg: config, agentId: "main", sessionKey: targetKey }),
    });
    await execution.start();
    try {
      await execution.run(job.id, "force");
      const outcome = execution.getJob(job.id)?.state;
      if (scenario === "foreign") {
        expect(reads).toEqual([]);
        expect(outcome).toMatchObject({
          lastRunStatus: "error",
          lastError: expect.stringContaining("owning conversation"),
        });
      } else {
        expect(outcome?.lastRunStatus, outcome?.lastError).toBe("ok");
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain(scenario === "operator" ? "FOREIGN_WORKSPACE" : "OWN_WORKSPACE");
      }
    } finally {
      execution.stop();
    }
  },
);

it.for(["resume", "stop"] as const)(
  "retains the same on-exit reply and notice across late foreground admission: %s",
  async (completion, { signal }) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          workspace: stateDir,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: stateDir } },
      },
      logging: { audit: { executionIdentity: true } },
      plugins: { enabled: false },
      skills: { load: { watch: false } },
    };
    setRuntimeConfigSnapshot(config);
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const execution = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      isExecutionIdle: (job, ownSessionKey, ownReplyOperation) =>
        isCronExecutionIdle(config, job, "main", ownSessionKey, ownReplyOperation),
      runIsolatedAgentJob: async () => {
        throw new Error("Expected ordinary session execution");
      },
      runSessionEvent: (request) =>
        runCronSessionTurn({ ...request, cfg: config, agentId: "main", sessionKey: SESSION }),
    });
    const schedule = { kind: "on-exit", command: "observed-command" } as const;
    const job = await execution.add({
      name: "Retained on-exit output",
      agentId: "main",
      enabled: true,
      deleteAfterRun: false,
      schedule,
      sessionTarget: `session:${SESSION}`,
      wakeMode: "now",
      idleOnly: true,
      payload: { kind: "agentTurn", message: "Process the observed completion" },
      delivery: { mode: "none" },
    });
    const target = await captureSessionEventTargetForHost("main", SESSION);
    const noticeText = "Exact pending notice for the observed exit";
    enqueueAutomationSystemEvent(
      noticeText,
      { sessionKey: SESSION },
      {
        jobId: job.id,
        assertCurrent: () => assertSessionEventTargetCurrent(target),
        prepare: () => prepareSessionEventTargetForHost(target),
      },
    );
    const notice = expectDefined(peekSystemEventEntries(SESSION)[0], "queued notice");
    const idleWait = createDeferred();
    let injected = false;
    let foreground: ReplyOperation | undefined;
    let scheduledOperation: ReplyOperation | undefined;
    const unsubscribe = onGatewayWorkMetricsChanged(() => {
      const operation = replyRunRegistry.get(SESSION);
      if (!injected && operation) {
        injected = true;
        scheduledOperation = operation;
        foreground = createReplyOperation({
          sessionKey: "agent:main:chat:foreground-at-admission",
          sessionId: "foreground-at-admission",
          resetTriggered: false,
          turnKind: "visible",
        });
      }
      if (foreground && operation && isCronReplyOperationWaitingForIdle(operation)) {
        idleWait.resolve();
      }
    });
    const bind = vi.spyOn(executionBinding, "bindCronRunReceiptExecution");
    const onReserved = vi.fn();
    let receiptAtWait: ReturnType<typeof inspectActiveCronRunReceipt>;
    runEmbeddedAgentMock.mockImplementation(async (params) => {
      expect(replyRunRegistry.get(SESSION)).toBe(scheduledOperation);
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })?.receiptId).toBe(
        receiptAtWait?.receiptId,
      );
      const admitted = await expectDefined(
        params.preparedRunAdmission,
        "scheduled admission",
      ).admit("gateway", params.runId);
      await params.onExecutionStarted?.();
      expect(admitted.operationalRunInstance.runId).toBe(params.runId);
      expect(replyRunRegistry.get(SESSION)).toBe(scheduledOperation);
      expect(params.prompt.split(noticeText)).toHaveLength(2);
      expect(params.prompt).toContain("Exact observed command output");
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "Observed exit handled" }], meta: { durationMs: 1 } };
    });
    const pending = execution.runOnExit(job.id, {
      schedule,
      signal,
      commitGuard: () => {},
      onReserved,
      payload: () => ({ kind: "agentTurn", message: "Exact observed command output" }),
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(idleWait.promise, pending, "on-exit idle wait was bypassed"),
        signal,
      );
      receiptAtWait = expectDefined(
        inspectActiveCronRunReceipt({ storePath, jobId: job.id }),
        "active receipt while idle",
      );
      const database = openOpenClawStateDatabase().db;
      expect(
        executeSqliteQueryTakeFirstSync(
          database,
          getNodeSqliteKysely<CronRunReceiptDatabase>(database)
            .selectFrom("cron_run_receipts")
            .select(["receipt_id", "status"])
            .where("receipt_id", "=", receiptAtWait.receiptId),
        ),
      ).toEqual({ receipt_id: receiptAtWait.receiptId, status: "running" });
      expect(
        isCronReplyOperationWaitingForIdle(expectDefined(scheduledOperation, "scheduled reply")),
      ).toBe(true);
      expect(onReserved).toHaveBeenCalledOnce();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(SESSION).some((event) => event.id === notice.id)).toBe(true);
      if (completion === "stop") {
        expect(replyRunRegistry.abort(SESSION)).toBe(true);
      } else {
        foreground?.complete();
      }
      await withinTest(pending, signal);
      expect(onReserved).toHaveBeenCalledOnce();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      if (completion === "stop") {
        expect(foreground?.abortSignal.aborted).toBe(false);
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(bind).not.toHaveBeenCalled();
      } else {
        expect(execution.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(bind).toHaveBeenCalledOnce();
        expect(peekSystemEventEntries(SESSION).some((event) => event.id === notice.id)).toBe(false);
      }
    } finally {
      unsubscribe();
      foreground?.complete();
      execution.stop();
      await Promise.allSettled([pending]);
      bind.mockRestore();
      resetSystemEventsForTest();
    }
  },
);
