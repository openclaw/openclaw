import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { CronService } from "../../cron/service.js";
import { saveCronStore } from "../../cron/store.js";
import { makeCronReceiptJob } from "../../cron/store/run-receipt-store.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import { createMessageTool } from "./message-tool-execution.js";

type CronMessageRun = {
  admitted: AdmittedRunContext;
  messageActionTurnCapability: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  createTool: (
    options?: NonNullable<Parameters<typeof createMessageTool>[0]>,
  ) => ReturnType<typeof createMessageTool>;
  revokeMessage: () => Promise<unknown>;
  closeAdmission: () => void;
};

/** Use real reservation, activation, message admission and completion owners without a Gateway boot. */
export async function withCronMessageRun<T>(
  params: { cfg: OpenClawConfig; storePath: string; sessionKey: string; sessionId: string },
  run: (owner: CronMessageRun) => Promise<T>,
): Promise<T> {
  const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
  const job = {
    ...makeCronReceiptJob("message-entrypoint", "main"),
    payload: {
      kind: "agentTurn" as const,
      message: "synthetic entrypoint proof",
      toolsAllow: ["message"],
    },
    delivery: { mode: "none" as const },
    scheduledToolPolicy,
  };
  await saveCronStore(params.storePath, { version: 1, jobs: [job] });
  const result: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
  const cron = new CronService({
    storePath: params.storePath,
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    defaultAgentId: "main",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async (execution) => {
      const runId = "message-entrypoint-run";
      const admission = prepareCronRunAdmission({
        cfg: params.cfg,
        agentId: "main",
        runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        jobId: job.id,
        admissionSource: execution.admissionSource,
        deliveryAttemptFence: execution.deliveryAttemptFence,
        executionIdentity: execution.executionIdentity,
        toolsAllow: ["message"],
        scheduledToolPolicy,
      });
      try {
        const admitted = await admission.preparedRunAdmission.admit("embedded");
        const messageActionTurnCapability = admission.messageActionTurnCapability;
        if (!messageActionTurnCapability) {
          throw new Error("Cron did not publish its message capability");
        }
        const catalog: ReturnType<typeof createMessageTool>[] = [];
        const invocationPolicy = createEmbeddedMessageInvocationPolicy({
          config: params.cfg,
          capabilityProfile: resolveConversationCapabilityProfile({
            config: params.cfg,
            agentId: "main",
            runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            scheduledToolPolicy,
          }),
          runtimeProfileAlsoAllow: ["message"],
          toolSearchControlAllowlist: [],
          scheduledToolPolicy,
          catalog: () => ({ tools: catalog }),
          isAvailable: () => catalog.some((tool) => tool.name === "message"),
        });
        const value = await run({
          admitted,
          messageActionTurnCapability,
          runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          createTool(options = {}) {
            const tool = createMessageTool({
              ...options,
              config: params.cfg,
              agentId: "main",
              runId,
              sessionId: params.sessionId,
              agentSessionKey: params.sessionKey,
              agentAccountId: "default",
              messageActionTurnCapability,
              admitScheduledInvocation: invocationPolicy.admit,
              getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
              resolveCommandSecretRefsViaGateway: async ({ config }) => ({
                resolvedConfig: config,
                diagnostics: [],
                targetStatesByPath: {},
                hadUnresolvedTargets: false,
              }),
            });
            catalog.push(tool);
            return tool;
          },
          revokeMessage: () =>
            cron.update(job.id, { payload: { kind: "agentTurn", toolsAllow: ["read"] } }),
          closeAdmission: () => admission.close(),
        });
        result.outcome = { ok: true, value };
        return { status: "ok" };
      } catch (error) {
        result.outcome = { ok: false, error };
        return { status: "error", error: String(error) };
      } finally {
        admission.close();
      }
    },
  });
  try {
    await cron.run(job.id, "force");
    const outcome = result.outcome;
    if (!outcome) {
      throw new Error("Cron did not enter its isolated runner");
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    cron.stop();
    await cron.waitForIdle();
  }
}
