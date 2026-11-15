import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { CronService } from "../../cron/service.js";
import { saveCronStore } from "../../cron/store.js";
import { makeCronReceiptJob } from "../../cron/store/run-receipt-store.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import { createMessageTool } from "./message-tool-execution.js";

type CronMessageRun = {
  createTool: typeof createMessageTool;
  closeAdmission: () => void;
};

export async function withCronMessageRun<T>(
  params: { cfg: OpenClawConfig; storePath: string; sessionKey: string; sessionId: string },
  run: (owner: CronMessageRun) => Promise<T>,
): Promise<T> {
  const { cfg, storePath, sessionKey, sessionId } = params;
  const identity = { agentId: "main", runId: "message-entrypoint-run", sessionId };
  const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
  const scope = { ...identity, sessionKey, scheduledToolPolicy };
  const job = {
    ...makeCronReceiptJob("message-entrypoint", "main"),
    payload: { kind: "agentTurn" as const, message: "proof", toolsAllow: ["message"] },
    delivery: { mode: "none" as const },
    scheduledToolPolicy,
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  let unwrap = (): T => {
    throw new Error("Cron did not enter its isolated runner");
  };
  const cron = new CronService({
    storePath,
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    defaultAgentId: "main",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async (execution) => {
      const { preparedRunAdmission, messageActionTurnCapability, close } = prepareCronRunAdmission({
        ...scope,
        scheduledExecution: execution.occurrence.mint({
          cfg,
          agentId: scope.agentId,
          runId: scope.runId,
          runSessionKey: scope.sessionKey,
        }),
        cfg,
        jobId: job.id,
        admissionSource: execution.admissionSource,
        deliveryAttemptFence: execution.deliveryAttemptFence,
        executionIdentity: execution.executionIdentity,
        toolsAllow: ["message"],
      });
      try {
        await preparedRunAdmission.admit("embedded");
        if (!messageActionTurnCapability) {
          throw new Error("Cron did not publish its message capability");
        }
        const catalog: ReturnType<typeof createMessageTool>[] = [];
        const invocationPolicy = createEmbeddedMessageInvocationPolicy({
          config: cfg,
          capabilityProfile: resolveConversationCapabilityProfile({ ...scope, config: cfg }),
          runtimeProfileAlsoAllow: ["message"],
          toolSearchControlAllowlist: [],
          scheduledToolPolicy,
          catalog: () => ({ tools: catalog }),
          isAvailable: () => catalog.some((tool) => tool.name === "message"),
        });
        const value = await run({
          createTool(options = {}) {
            const tool = createMessageTool({
              ...options,
              ...identity,
              config: cfg,
              agentSessionKey: sessionKey,
              agentAccountId: "default",
              messageActionTurnCapability,
              admitScheduledInvocation: invocationPolicy.admit,
            });
            catalog.push(tool);
            return tool;
          },
          closeAdmission: close,
        });
        unwrap = () => value;
        return { status: "ok" };
      } catch (error) {
        unwrap = () => {
          throw error;
        };
        return { status: "error", error: String(error) };
      } finally {
        close();
      }
    },
  });
  try {
    await cron.run(job.id, "force");
    return unwrap();
  } finally {
    cron.stop();
    await cron.waitForIdle();
  }
}
