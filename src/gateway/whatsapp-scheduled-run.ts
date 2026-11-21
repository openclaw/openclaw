import { getChannelPlugin } from "../channels/plugins/registry.js";
import { getRuntimeConfig } from "../config/io.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { hasWhatsAppAutomationPermission } from "../cron/whatsapp-automation.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";

export const runWhatsAppAutomation: NonNullable<
  CronServiceDeps["deliverWhatsAppAutomation"]
> = async (job, signal, fence, runTask) => {
  const payload = job.payload;
  if (payload.kind !== "whatsappAutomation" || !job.agentId || !job.state.runningAtMs) {
    return { status: "skipped", error: "Missing private schedule." };
  }
  const cfg = getRuntimeConfig();
  const assertCurrent = () => {
    signal.throwIfAborted();
    fence.assertCurrent();
  };
  if (!(await hasWhatsAppAutomationPermission(cfg, payload))) {
    return { status: "skipped", delivered: false, error: "WhatsApp DM access ended." };
  }
  let text = job.name;
  if (payload.task) {
    const sessionKey = buildAgentPeerSessionKey({
      agentId: job.agentId,
      accountId: payload.accountId,
      channel: "whatsapp",
      peerId: payload.peer,
      dmScope: "per-account-channel-peer",
    });
    // Build a requester job from the personal record. Only the bound account and private peer
    // can receive the terminal result; the agent does not own a delivery route.
    const result = await runTask(
      {
        id: job.id,
        name: job.name,
        agentId: job.agentId,
        schedule: job.schedule,
        enabled: job.enabled,
        createdAtMs: job.createdAtMs,
        updatedAtMs: job.updatedAtMs,
        state: job.state,
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        delivery: { mode: "none" },
        failureAlert: false,
        owner: { sessionKey, accountId: payload.accountId, agentId: job.agentId },
        sourceConversation: { sessionKey, sessionId: payload.task.sessionId },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: sessionKey,
          ownerAccountId: payload.accountId,
        },
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "external", channel: "whatsapp" },
        },
        payload: {
          kind: "agentTurn",
          message: job.name,
          lightContext: true,
          toolsAllow: payload.task.tools.map((tool) => tool.name),
        },
      },
      job.name,
      {
        accountId: payload.accountId,
        senderId: payload.peer,
        tools: payload.task.tools,
        assertCurrent,
      },
    );
    if (result.status !== "ok" || !result.outputText?.trim()) {
      return {
        status: result.status,
        delivered: false,
        error: result.error,
        executionStarted: result.executionStarted,
      };
    }
    text = result.outputText;
  }
  assertCurrent();
  const sendText = getChannelPlugin("whatsapp")?.outbound?.sendText;
  if (!sendText) {
    return { status: "skipped", delivered: false, error: "WhatsApp is unavailable." };
  }
  const receipt = await sendText({
    cfg,
    accountId: payload.accountId,
    to: payload.peer,
    text,
    onPlatformSendDispatch: async () => {
      await fence.beforeAttempt();
      assertCurrent();
    },
  });
  return receipt.messageId
    ? { status: "ok", delivered: true }
    : { status: "error", delivered: false, error: "WhatsApp returned no message id." };
};
