import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { admitModelTurn, completionConfig } from "../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createGatewayCronTargetResolver } from "../gateway/server-cron-targets.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

// mock-isolation: Only model output is synthetic; fallback admission and session execution are real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const target = "agent:ops:telegram:group:42:topic:77";
const otherConversation = "agent:ops:discord:channel:other";
const deliveryContext: DeliveryContext = { channel: "telegram", to: "-10042", threadId: 77 };

it.for([
  ["persistent target", `session:${target}`, otherConversation, "now", true],
  ["targeted next-heartbeat", "isolated", target, "next-heartbeat", true],
  ["default owner", "isolated", undefined, "now", false],
  ["deferred default owner", "isolated", undefined, "next-heartbeat", false],
] as const)(
  "routes a rejected failure alert to %s with scheduling disabled",
  async ([_name, sessionTarget, creationSessionKey, wakeMode, carriesOrigin], { signal }) => {
    await withOpenClawTestState(
      { label: "cron-failure-notification", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const agentId = carriesOrigin ? "ops" : "main";
        const expectedSessionKey = carriesOrigin ? target : "agent:main:main";
        const cfg = completionConfig(state.workspaceDir);
        cfg.agents!.entries!.ops = { workspace: state.workspaceDir };
        setRuntimeConfigSnapshot(cfg);
        await state.writeConfig(cfg);
        openOpenClawStateDatabase();
        await replaceSessionEntry(
          { agentId, sessionKey: expectedSessionKey },
          {
            sessionId: "failure-notification-session",
            lifecycleRevision: "original",
            permissionMode: "full",
            updatedAt: Date.now(),
          },
        );
        const receipts: SessionEventReceipt[] = [];
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        const observer = vi
          .spyOn(sessionEvents, "enqueueSessionEventForHost")
          .mockImplementation((...args) => {
            const receipt = enqueue(...args);
            receipts.push(receipt);
            return receipt;
          });
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          await admitModelTurn(params);
          return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
        });
        const logger = createNoopLogger();
        const adapter = createGatewayCronTargetResolver(state.env, logger);
        const sendCronFailureAlert: NonNullable<CronServiceDeps["sendCronFailureAlert"]> = async (
          params,
        ) => {
          await params.onDeliverySettled({
            delivered: false,
            status: "not-delivered",
            error: "failure alert channel unavailable",
          });
          throw new Error("failure alert channel unavailable");
        };
        const failRun = async () => ({
          status: "error" as const,
          error: "temporary upstream error",
        });
        const deps = cronTestDeps({
          storePath: state.statePath("cron", "jobs.json"),
          cronEnabled: false,
          cronConfig: { failureAlert: { enabled: true, after: 1 } },
          defaultAgentId: "main",
          log: logger,
          resolveOriginDeliveryContext: async () => deliveryContext,
          enqueueSessionEvent: adapter.enqueueSessionEvent,
          sendCronFailureAlert,
          runIsolatedAgentJob: failRun,
          runSessionEvent: failRun,
        });
        const cron = new CronService(deps);
        try {
          await cron.start();
          const job = await cron.add({
            ...cronTestInput(),
            name: "Important report",
            sessionTarget,
            sessionKey: creationSessionKey,
            wakeMode,
          });

          await cron.run(job.id, "force");
          expect(receipts).toHaveLength(1);
          await expect(withinTest(receipts[0]!.accepted, signal)).resolves.toEqual({ ok: true });
          await expect(withinTest(receipts[0]!.settled, signal)).resolves.toMatchObject({
            status: "completed",
            executionStarted: true,
          });
          expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
          const turn = runEmbeddedAgentMock.mock.calls[0]![0];
          expect(turn).toMatchObject({
            sessionKey: expectedSessionKey,
            trigger: "event",
          });
          expect(turn.prompt).toContain('Automation "Important report" failed 1 times');
          expect(turn.messageTo).toBe(carriesOrigin ? deliveryContext.to : undefined);
          expect(turn.messageThreadId).toBe(carriesOrigin ? deliveryContext.threadId : undefined);
          expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(expectedSessionKey)).toEqual([]);
        } finally {
          cron.stop();
          for (const receipt of receipts) {
            receipt.cancel();
          }
          await Promise.allSettled([
            cron.waitForIdle(),
            ...receipts.map((receipt) => receipt.settled),
          ]);
          observer.mockRestore();
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);
