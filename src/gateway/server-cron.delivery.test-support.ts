import type { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";

export const resolveCronTestDeliveryTarget: typeof resolveDeliveryTarget = async (
  _cfg,
  agentId,
  target,
) => {
  const channel = !target.channel || target.channel === "last" ? "telegram" : target.channel;
  const to = target.to ?? "123";
  const sessionKey = `agent:${agentId}:${channel}:direct:${to}`;
  return {
    ok: true,
    channel,
    to,
    accountId: target.accountId,
    threadId: target.threadId,
    mode: "explicit",
    sessionRoute: {
      sessionKey,
      baseSessionKey: sessionKey,
      peer: { kind: "direct", id: to },
      chatType: "direct",
      from: `${channel}:${to}`,
      to,
      recipientSessionExact: false,
    },
  };
};
