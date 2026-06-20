import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { readSessionEntry } from "../../config/sessions/store-load.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { registerInternalHook, type InternalHookEvent } from "../../hooks/internal-hooks.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { consumeStreamingEchoHandled } from "./mirror-dispatch.js";
import { fireEchoDeliveries } from "./echo.js";

let registered = false;

export function registerEchoHook(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerInternalHook("message:sent", handleMessageSent);
  registerInternalHook("message:received", handleMessageReceived);
}

function resolveSessionEchoEntry(
  sessionKey: string,
): { cfg: ReturnType<typeof getRuntimeConfig>; entry: SessionEntry } | undefined {
  let cfg;
  try {
    cfg = getRuntimeConfig();
  } catch {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  // For selected-global sessions ("global" key without embedded agent),
  // resolve the default agent so we read the correct agent-scoped store.
  const agentId =
    parsed?.agentId ?? (sessionKey === "global" ? resolveDefaultAgentId(cfg) : undefined);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const entry = readSessionEntry(storePath, sessionKey) as SessionEntry | undefined;
    if (!entry?.echoTargets?.length) {
      return undefined;
    }
    return { cfg, entry };
  } catch {
    return undefined;
  }
}

async function handleMessageSent(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as {
    to?: string;
    content?: string;
    success?: boolean;
    channelId?: string;
    accountId?: string;
  } | null;

  if (!ctx?.success || !ctx.content || !event.sessionKey) {
    return;
  }

  const resolved = resolveSessionEchoEntry(event.sessionKey);
  if (!resolved) {
    return;
  }

  const originChannel = ctx.channelId ?? "";
  const originTo = ctx.to ?? "";
  if (!originChannel || !originTo) {
    return;
  }

  const sessionKey = event.sessionKey;
  void fireEchoDeliveries(
    {
      cfg: resolved.cfg,
      sessionKey,
      sessionEntry: resolved.entry,
      originChannel,
      originTo,
      originAccountId: ctx.accountId,
      originThreadId: resolved.entry.lastThreadId,
      role: "assistant",
    },
    [{ text: ctx.content }],
    // Native-final delivery: the response mirrors to pinned channels as a normal,
    // natively-formatted reply (no "[echo]" prefix). Only the user prompt is marked
    // as an echo.
    //
    // B-full: targets already rendered live by a streaming echo renderer are skipped
    // here so they don't get a duplicate final. Non-streaming targets (and channels
    // without a renderer) fall through to this post-hoc mirror as before.
    {
      prefixed: false,
      filterTargets: (target) => !consumeStreamingEchoHandled(sessionKey, target),
    },
  );
}

async function handleMessageReceived(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as {
    from?: string;
    content?: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    echoUserAlreadyDelivered?: boolean;
    metadata?: { threadId?: string | number };
  } | null;

  if (!ctx?.content || !event.sessionKey || ctx.echoUserAlreadyDelivered === true) {
    return;
  }

  const resolved = resolveSessionEchoEntry(event.sessionKey);
  if (!resolved) {
    return;
  }

  const originChannel = ctx.channelId ?? "";
  const originTo = ctx.conversationId ?? ctx.from ?? "";
  if (!originChannel || !originTo) {
    return;
  }

  void fireEchoDeliveries(
    {
      cfg: resolved.cfg,
      sessionKey: event.sessionKey,
      sessionEntry: resolved.entry,
      originChannel,
      originTo,
      originAccountId: ctx.accountId,
      originThreadId: ctx.metadata?.threadId ?? resolved.entry.lastThreadId,
      role: "user",
    },
    [{ text: ctx.content }],
  );
}
