import type { ReplyPayload } from "../../auto-reply/types.js";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import { isEchoTargetAdmissible } from "./channel-admission.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";

export function normalizeEchoTargetId(channel: string, to: string): string {
  const trimmed = to.trim();
  if (channel === "telegram") {
    // Strip transport prefixes AND a trailing `:topic:<n>` forum-topic suffix.
    // The topic is carried separately by threadId in every comparison (echo
    // target key, self-exclusion, participant match), so the chat-id comparison
    // must be topic-agnostic — otherwise a topic-qualified pinned target
    // (`telegram:-100:topic:7`) never matches the bare origin chat id (`-100`)
    // the post-hoc message:sent path supplies, so the origin forum topic fails
    // to self-exclude (duplicate echo) and a same-thread operator add is rejected.
    return trimmed
      .replace(/^(telegram|tg):/i, "")
      .replace(/^group:/i, "")
      .replace(/:topic:\d+$/i, "")
      .trim();
  }
  return trimmed;
}

// A mirror recipient must be a thread that is actually bound to the session it
// mirrors — never an arbitrary chat id. The session entry's last* fields record
// the most recent thread that drove this session, which is the one destination
// we can verify routes here (it just did). Operator add paths use this to reject
// arbitrary targets; in-chat /pin captures these same fields from its own
// context so it is always a participant. (There is no reverse index of every
// thread ever bound, so this verifies against the known participant and fails
// closed — use /pin from the target thread for any other thread.)
export function targetMatchesSessionParticipant(
  entry: SessionEntry,
  target: { channel: string; to: string; accountId?: string; threadId?: string | number },
): boolean {
  const participantChannel = entry.lastChannel ?? entry.channel;
  if (!participantChannel || !entry.lastTo) {
    return false;
  }
  const sameChannel = target.channel === participantChannel;
  const sameTo =
    normalizeEchoTargetId(target.channel, target.to) ===
    normalizeEchoTargetId(participantChannel, entry.lastTo);
  const sameAccount = (target.accountId ?? "") === (entry.lastAccountId ?? "");
  const sameThread = String(target.threadId ?? "") === String(entry.lastThreadId ?? "");
  return sameChannel && sameTo && sameAccount && sameThread;
}

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
    const sameTo =
      normalizeEchoTargetId(target.channel, target.to) ===
      normalizeEchoTargetId(params.originChannel, params.originTo);
    // A target with no pinned accountId is a wildcard for self-exclusion: it
    // would route back to the same conversation via the origin/default account,
    // so a same channel+to+thread inbound is still "the same place" and must be
    // excluded. Telegram inbounds resolve accountId to "default", so a target
    // added without an account would otherwise never match origin and echo to
    // itself. A target that *does* pin an account is a deliberate, distinct
    // destination and only self-excludes against that same account.
    const sameAccount = !target.accountId || target.accountId === params.originAccountId;
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

// SAFETY: This function MUST NOT pass `session` or `mirror` to
// deliverOutboundPayloadsInternal. Those params set sessionKeyForInternalHooks
// (deliver.ts:1544), which gates the internal `message:sent` hook
// (deliver.ts:1003). If that hook fires for echo deliveries, echo-hook.ts
// re-enters fireEchoDeliveries -> infinite loop. Omitting session/mirror
// keeps canEmitInternalHook=false and breaks the cycle.
export async function fireEchoDeliveries(
  ctx: EchoDeliveryContext,
  payloads: ReplyPayload[],
  options?: {
    prefixed?: boolean;
    /**
     * Drop targets for which this returns false. Used to skip targets a mirror
     * turn already rendered natively (mirror-dispatch) so the post-hoc final
     * mirror does not double-deliver. Injected (not imported) to avoid a
     * mirror-dispatch import cycle.
     */
    filterTargets?: (target: SessionEchoTarget) => boolean;
  },
): Promise<void> {
  const resolvedTargets = resolveEchoTargets(ctx.sessionEntry, {
    originChannel: ctx.originChannel,
    originTo: ctx.originTo,
    originAccountId: ctx.originAccountId,
    originThreadId: ctx.originThreadId,
    role: ctx.role,
  });
  const filteredTargets = options?.filterTargets
    ? resolvedTargets.filter(options.filterTargets)
    : resolvedTargets;

  // Honor the destination channel's live enablement/authorization. The echo path
  // delivers via the channel-agnostic raw send (no per-message admission gate), so
  // a disabled (revoked) group/topic — or a DM whose pairing/allowlist access was
  // revoked — would keep receiving echoes unless we check here. The predicate may
  // be async (telegram re-checks DM access). Fail closed: drop targets a registered
  // channel predicate reports as inadmissible.
  const admissions = await Promise.all(
    filteredTargets.map((target) =>
      isEchoTargetAdmissible(ctx.cfg, target.channel, {
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
      }).catch((err: unknown) => {
        // Fail closed on a predicate error: do not echo to a target we could not
        // verify, and never reject the (fire-and-forget) echo as a whole.
        log.warn(
          `Echo admission check failed for ${target.channel}:${target.to}: ${formatErrorMessage(err)}`,
        );
        return false;
      }),
    ),
  );
  const targets = filteredTargets.filter((target, index) => {
    if (admissions[index]) {
      return true;
    }
    log.warn(
      `Echo delivery suppressed for ${target.channel}:${target.to} (destination disabled/revoked)`,
    );
    return false;
  });

  if (targets.length === 0) {
    return;
  }

  // The prompt echo keeps its "[via <channel>]" marker so it reads as a mirror of input
  // typed elsewhere. The assistant response is fanned out un-prefixed so it renders as a
  // native reply on each pinned channel (prefixed: false).
  const echoPayloads =
    options?.prefixed === false ? payloads : prefixPayloads(payloads, formatEchoPrefix(ctx));

  for (const target of targets) {
    deliverOutboundPayloadsInternal({
      cfg: ctx.cfg,
      channel: target.channel,
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
