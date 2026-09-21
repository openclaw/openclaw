import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionDeliveryRoute } from "../infra/session-delivery-queue.records.js";
import { getUpdateRun, recordUpdateRunVerification } from "../infra/update-run-ledger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  hasDeliveryTargetFields,
  mergeDeliveryContext,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveGatewayLifecycleNoticeRoute } from "./server-restart-sentinel-notice.js";
import { loadSessionEntry } from "./session-utils.js";

type NoticeSession = ReturnType<typeof loadSessionEntry>;
const log = createSubsystemLogger("gateway/update-run");
type NoticeTarget =
  | { kind: "route"; route: SessionDeliveryRoute }
  | { kind: "internal"; session: NoticeSession & { entry: SessionEntry } }
  | { kind: "none"; reason: string };

function isUpdateNoticeSendEnabled(cfg: OpenClawConfig, route: SessionDeliveryRoute): boolean {
  const channel = asOptionalRecord(cfg.channels?.[route.channel]);
  const plugin = route.accountId ? undefined : getChannelPlugin(route.channel);
  const accountId = normalizeAccountId(
    route.accountId ?? (plugin ? resolveChannelDefaultAccountId({ plugin, cfg }) : undefined),
  );
  const account = asOptionalRecord(
    resolveChannelAccountEntry(
      asOptionalRecord(channel?.accounts),
      accountId,
      route.channel,
      normalizeAccountId,
    ),
  );
  const baseSendMessage = asOptionalRecord(channel?.actions)?.sendMessage;
  const accountSendMessage = asOptionalRecord(account?.actions)?.sendMessage;
  return createAccountActionGate({
    baseActions: {
      sendMessage: typeof baseSendMessage === "boolean" ? baseSendMessage : undefined,
    },
    accountActions: {
      sendMessage: typeof accountSendMessage === "boolean" ? accountSendMessage : undefined,
    },
  })("sendMessage");
}

export function authorizeUpdateRunNoticeTarget(
  cfg: OpenClawConfig,
  target: NoticeTarget,
): NoticeTarget {
  if (target.kind === "route" && !isUpdateNoticeSendEnabled(cfg, target.route)) {
    return {
      kind: "none",
      reason: `update lifecycle notices are disabled by ${target.route.channel} actions.sendMessage policy`,
    };
  }
  return target.kind === "route" &&
    !isConfiguredCommandOwner(cfg, { ...target.route, senderId: target.route.to })
    ? { kind: "none", reason: "target is not a configured command owner" }
    : target;
}

export function recordUpdateRunNoticeSkipped(
  runId: string | undefined,
  reason: string,
  env?: NodeJS.ProcessEnv,
): void {
  log.warn(`lifecycle notice skipped: ${reason}`, { runId });
  if (runId && getUpdateRun(runId, { env })?.verification.noticeDelivered !== true) {
    recordUpdateRunVerification(runId, { noticeDelivered: false }, { env });
  }
}

/** Resolve the origin once; internal sessions intentionally have no external delivery context. */
export function resolveUpdateRunNoticeTarget(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  explicitDeliveryContext?: DeliveryContext;
  threadId?: string;
  session?: NoticeSession;
  env?: NodeJS.ProcessEnv;
}): NoticeTarget {
  const session =
    params.session ??
    (params.sessionKey ? loadSessionEntry(params.sessionKey, { env: params.env }) : undefined);
  const routingKey = params.sessionKey ?? session?.canonicalKey;
  const { baseSessionKey, threadId } = parseSessionThreadInfo(routingKey);
  let context = deliveryContextFromSession(session?.entry);
  let chatType = sessionDeliveryOrigin(session?.entry)?.chatType ?? "direct";
  if (!hasDeliveryTargetFields(context) && baseSessionKey && baseSessionKey !== routingKey) {
    const { entry } = loadSessionEntry(baseSessionKey, { env: params.env });
    chatType =
      sessionDeliveryOrigin(session?.entry)?.chatType ??
      sessionDeliveryOrigin(entry)?.chatType ??
      "direct";
    context = mergeDeliveryContext(context, deliveryContextFromSession(entry));
  }
  const origin = mergeDeliveryContext(params.explicitDeliveryContext, context);
  if (
    isInternalMessageChannel(origin?.channel) ||
    (!origin?.channel && session?.entry?.delivery?.kind !== "external")
  ) {
    return session?.entry
      ? { kind: "internal", session: { ...session, entry: session.entry } }
      : { kind: "none", reason: "no delivery target" };
  }
  const route = resolveGatewayLifecycleNoticeRoute({
    cfg: params.cfg,
    deliveryContext: origin,
    // Ambient recovery keeps the persisted system route thread; origin keys can supply hints.
    threadId: params.threadId ?? (params.sessionKey ? threadId : undefined),
  });
  return authorizeUpdateRunNoticeTarget(
    params.cfg,
    route
      ? { kind: "route", route: { ...route, chatType } }
      : { kind: "none", reason: "no delivery target" },
  );
}
