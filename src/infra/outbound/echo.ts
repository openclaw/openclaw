import type { ReplyPayload } from "../../auto-reply/types.js";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";

const log = createSubsystemLogger("outbound/echo");

export type EchoDeliveryContext = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionEntry: SessionEntry;
  originChannel: string;
  originTo: string;
  originAccountId?: string;
  originThreadId?: string | number;
  role: "user" | "assistant";
};

export function resolveEchoTargets(
  entry: SessionEntry | undefined,
  params: {
    originChannel: string;
    originTo: string;
    originAccountId?: string;
    originThreadId?: string | number;
    role: "user" | "assistant";
  },
): SessionEchoTarget[] {
  if (!entry?.echoTargets?.length) {
    return [];
  }
  return entry.echoTargets.filter((target) => {
    if (params.role === "user" && target.echoUser === false) {
      return false;
    }
    if (params.role === "assistant" && target.echoAssistant === false) {
      return false;
    }
    const sameChannel = target.channel === params.originChannel;
    const sameTo = target.to === params.originTo;
    const sameAccount =
      (!target.accountId && !params.originAccountId) ||
      target.accountId === params.originAccountId;
    const sameThread =
      (!target.threadId && !params.originThreadId) ||
      String(target.threadId) === String(params.originThreadId);
    if (sameChannel && sameTo && sameAccount && sameThread) {
      return false;
    }
    return true;
  });
}

function formatEchoPrefix(ctx: EchoDeliveryContext): string {
  const source = ctx.originChannel;
  if (ctx.role === "user") {
    return `\u{1F4F1} [via ${source}] `;
  }
  return `\u{1F916} [echo] `;
}

function prefixPayloads(payloads: ReplyPayload[], prefix: string): ReplyPayload[] {
  return payloads.map((payload) => {
    if (!payload.text) {
      return payload;
    }
    return { ...payload, text: prefix + payload.text };
  });
}

export function fireEchoDeliveries(
  ctx: EchoDeliveryContext,
  payloads: ReplyPayload[],
): void {
  const targets = resolveEchoTargets(ctx.sessionEntry, {
    originChannel: ctx.originChannel,
    originTo: ctx.originTo,
    originAccountId: ctx.originAccountId,
    originThreadId: ctx.originThreadId,
    role: ctx.role,
  });

  if (targets.length === 0) {
    return;
  }

  const prefix = formatEchoPrefix(ctx);
  const echoPayloads = prefixPayloads(payloads, prefix);

  for (const target of targets) {
    deliverOutboundPayloadsInternal({
      cfg: ctx.cfg,
      channel: target.channel as Exclude<string, "none">,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: echoPayloads,
      bestEffort: true,
      skipQueue: true,
      silent: true,
    }).catch((err: unknown) => {
      log.warn(
        `Echo delivery failed for ${target.channel}:${target.to}: ${formatErrorMessage(err)}`,
      );
    });
  }
}
