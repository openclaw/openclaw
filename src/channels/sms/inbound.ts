import { agentCommandFromIngress } from "../../agents/agent-command.js";
import { loadConfig } from "../../config/config.js";
import type { NodeEventContext } from "../../gateway/server-node-events-types.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { defaultRuntime } from "../../runtime.js";
import { isSenderIdAllowed, mergeDmAllowFromSources } from "../allow-from.js";

const SMS_CHANNEL_ID = "sms";

function normalizePhoneNumber(raw: string): string {
  return raw.replace(/[\s\-.()]/g, "");
}

export async function handleIncomingSms(
  ctx: NodeEventContext,
  nodeId: string,
  payload: { from: string; body: string; timestampMs: number },
) {
  const from = normalizePhoneNumber(payload.from);
  if (!from || !payload.body) {
    return;
  }

  const cfg = loadConfig();

  // Allowlist gating: only route SMS from allowed phone numbers
  const channels = (cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined;
  const smsConfig = channels?.sms as Record<string, unknown> | undefined;
  const rawAllowFrom = mergeDmAllowFromSources({
    allowFrom: smsConfig?.allowFrom as Array<string | number> | undefined,
  });
  // Normalize allowFrom entries with the same phone normalization so formats like
  // "+1 (555) 123-4567" match the normalized sender "+15551234567".
  const allowFrom = rawAllowFrom.map((entry) =>
    entry === "*" ? entry : normalizePhoneNumber(entry),
  );
  const allowed = isSenderIdAllowed(
    {
      entries: allowFrom,
      hasWildcard: allowFrom.includes("*"),
      hasEntries: allowFrom.length > 0,
    },
    from,
    false, // reject when allowlist is empty
  );
  if (!allowed) {
    return;
  }

  const route = resolveAgentRoute({
    cfg,
    channel: SMS_CHANNEL_ID,
    accountId: "default",
    peer: { kind: "direct", id: from },
  });

  void agentCommandFromIngress(
    {
      message: payload.body,
      sessionKey: route.sessionKey,
      thinking: "low",
      deliver: true,
      to: from,
      channel: SMS_CHANNEL_ID,
      accountId: nodeId,
      messageChannel: SMS_CHANNEL_ID,
      inputProvenance: {
        kind: "external_user",
        sourceChannel: SMS_CHANNEL_ID,
        sourceTool: "gateway.sms.received",
      },
      senderIsOwner: false,
      allowModelOverride: false,
    },
    defaultRuntime,
    ctx.deps,
  ).catch((err) => {
    ctx.logGateway.warn(`sms inbound agent failed node=${nodeId} from=${from}: ${String(err)}`);
  });
}
