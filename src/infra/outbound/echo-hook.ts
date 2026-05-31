import { readSessionEntry } from "../../config/sessions/store-load.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import { resolveEchoTargets } from "./echo.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";

const log = createSubsystemLogger("outbound/echo-hook");

let registered = false;

export function registerEchoHook(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerInternalHook("message:sent", handleMessageSent);
}

async function handleMessageSent(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as {
    to?: string;
    content?: string;
    success?: boolean;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    messageId?: string;
    isGroup?: boolean;
    groupId?: string;
  } | null;

  if (!ctx?.success || !ctx.content || !event.sessionKey) {
    return;
  }

  let cfg;
  try {
    cfg = getRuntimeConfig();
  } catch {
    return;
  }

  const parsed = parseAgentSessionKey(event.sessionKey);
  const agentId = parsed?.agentId;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });

  let entry: SessionEntry | undefined;
  try {
    entry = readSessionEntry(storePath, event.sessionKey) as SessionEntry | undefined;
  } catch {
    return;
  }

  if (!entry?.echoTargets?.length) {
    return;
  }

  const originChannel = ctx.channelId ?? "";
  const originTo = ctx.to ?? "";
  if (!originChannel || !originTo) {
    return;
  }

  const targets = resolveEchoTargets(entry, {
    originChannel,
    originTo,
    originAccountId: ctx.accountId,
    role: "assistant",
  });

  if (targets.length === 0) {
    return;
  }

  const prefix = `\u{1F916} [echo] `;
  const echoPayloads = [{ text: prefix + ctx.content }];

  for (const target of targets) {
    deliverOutboundPayloadsInternal({
      cfg,
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
