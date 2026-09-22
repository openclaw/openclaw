import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  matchesConversationBindingRouteFacts,
  readConversationBindingRouteFacts,
  readConversationBindingRouteObservations,
  resolveConversationBindingSelection,
} from "../../channels/conversation-binding-route-facts.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  readSessionBindingSelectionCurrent,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
export function resolveSessionDefaultAccountId(params: {
  cfg: OpenClawConfig;
  channelRaw?: string;
  accountIdRaw?: string;
  persistedLastAccountId?: string;
}): string | undefined {
  const explicit = normalizeOptionalString(params.accountIdRaw);
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeOptionalString(params.persistedLastAccountId);
  if (persisted) {
    return persisted;
  }
  const channel = normalizeOptionalLowercaseString(params.channelRaw);
  if (!channel) {
    return undefined;
  }
  // SAFETY: only the optional defaultAccount field is read; its unknown value is normalized below.
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefault = channels?.[channel]?.defaultAccount;
  return normalizeOptionalString(configuredDefault);
}

export function resolveSessionConversationBindingContext(
  cfg: OpenClawConfig,
  ctx: MsgContext,
): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg,
    ctx,
  });
  if (!bindingContext) {
    return null;
  }
  return {
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  };
}

export async function resolveDispatchConversationBinding(cfg: OpenClawConfig, ctx: MsgContext) {
  if (resolveCommandTurnTargetSessionKey(ctx)) {
    return null;
  }
  const conversation =
    readConversationBindingRouteFacts(ctx)?.conversation ??
    resolveSessionConversationBindingContext(cfg, ctx);
  const selection = resolveConversationBindingSelection(
    conversation ? await getSessionBindingService().resolveByConversationAsync(conversation) : null,
  );
  return selection.kind === "none" ? null : selection.binding;
}

export async function resolveBoundAcpSessionForCommandReset(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  bindingContext?: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null;
}): Promise<string | undefined> {
  const bindingContext =
    params.bindingContext ?? resolveSessionConversationBindingContext(params.cfg, params.ctx);
  return await resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext?.channel,
    accountId: bindingContext?.accountId,
    conversationId: bindingContext?.conversationId,
    parentConversationId: bindingContext?.parentConversationId,
    commandTargetSessionKey: resolveCommandTurnTargetSessionKey(params.ctx),
    activeSessionKey: normalizeOptionalString(params.ctx.SessionKey),
    allowNonAcpBindingSessionKey: false,
    skipConfiguredFallbackWhenActiveSessionNonAcp: true,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

export function assertPreparedConversationBindingRoute(
  ctx: Pick<MsgContext, "SessionKey">,
  current: SessionBindingRecord | null,
): void {
  const expected = readConversationBindingRouteFacts(ctx);
  if (expected && !matchesConversationBindingRouteFacts(expected, current)) {
    // Session snapshot retries retain this channel-prepared context. Only ingress
    // can rebuild its route from the raw event and the current binding owner.
    throw new SessionWorkStartChangedError(
      "Conversation binding changed while preparing the reply. Retry the message.",
    );
  }
}

export async function readPreparedConversationBindingRouteCurrent(
  ctx: Pick<MsgContext, "SessionKey">,
): Promise<SessionBindingRecord | null> {
  const observations = readConversationBindingRouteObservations(ctx);
  if (observations.length === 0) {
    return null;
  }
  let current: ReadonlyArray<SessionBindingRecord | null>;
  try {
    current = await readSessionBindingSelectionCurrent(
      observations.map((expected) => expected.conversation),
    );
  } catch (error) {
    if (!isSessionBindingError(error) || error.code !== "BINDING_ADAPTER_UNAVAILABLE") {
      throw error;
    }
    throw new SessionWorkStartChangedError(
      "Conversation binding owner changed while preparing the reply. Retry the message.",
    );
  }
  for (const [index, expected] of observations.entries()) {
    if (!matchesConversationBindingRouteFacts(expected, current[index] ?? null)) {
      throw new SessionWorkStartChangedError(
        "Conversation binding changed while preparing the reply. Retry the message.",
      );
    }
  }
  return current.at(-1) ?? null;
}

export async function assertPreparedConversationBindingRouteCurrent(
  ctx: MsgContext,
): Promise<void> {
  if (!resolveCommandTurnTargetSessionKey(ctx)) {
    await readPreparedConversationBindingRouteCurrent(ctx);
  }
}

export async function resolveSessionConversationBinding(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  mode: "preprocessing" | "initialization";
}) {
  const { cfg, ctx, mode } = params;
  // Automated system events must not reset sessions or retarget conversation bindings.
  const isSystemEvent = ctx.InternalTurnSource !== undefined;
  const conversationBindingContext = isSystemEvent
    ? null
    : (readConversationBindingRouteFacts(ctx)?.conversation ??
      resolveSessionConversationBindingContext(cfg, ctx));
  // Slash/menu commands may arrive on a transport session while targeting the chat session.
  // Prefer explicit command target before binding lookup so command mutations land there.
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  let resolvedBinding: SessionBindingRecord | null | undefined;
  if (!commandTargetSessionKey && conversationBindingContext) {
    const service = getSessionBindingService();
    if (readConversationBindingRouteFacts(ctx)) {
      resolvedBinding = await readPreparedConversationBindingRouteCurrent(ctx);
    } else if (mode === "preprocessing") {
      const inspection = await service.inspectByConversationAsync(conversationBindingContext);
      if (inspection.status === "unavailable") {
        throw new Error("Conversation binding owner is temporarily unavailable; retry the reply.");
      }
      resolvedBinding = inspection.binding;
    } else {
      resolvedBinding = await service.resolveByConversationAsync(conversationBindingContext);
    }
    assertPreparedConversationBindingRoute(ctx, resolvedBinding);
  }
  const bindingSelection = resolveConversationBindingSelection(resolvedBinding ?? null);
  const conversationBinding =
    bindingSelection.kind === "none" ? undefined : bindingSelection.binding;
  return {
    isSystemEvent,
    conversationBindingContext,
    commandTargetSessionKey,
    conversationBinding,
  };
}
