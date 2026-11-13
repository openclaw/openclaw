import type { MsgContext } from "../auto-reply/templating.js";
import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { isCronSessionKey } from "./session-key-utils.js";

// Core and SDK chunks share one private key; context spreads retain the same consumed fact.
export const sessionParticipantInput = Symbol.for("openclaw.sessionParticipantInput");
export type SessionParticipantInputContext = MsgContext & {
  [sessionParticipantInput]?: Array<{
    identity: SessionParticipantIdentity;
    promptedAt: number;
    recorded: boolean;
  }>;
};

/** Trusted ingress prepares once; context spreads carry the same consumed fact through retargeting. */
export function prepareSessionParticipantInput(
  ctx: SessionParticipantInputContext,
  identity: SessionParticipantIdentity,
  promptedAt = Date.now(),
): void {
  (ctx[sessionParticipantInput] ??= []).push({ identity, promptedAt, recorded: false });
}

export function readSessionInputProfileId(ctx: SessionParticipantInputContext): string | undefined {
  const identity = ctx[sessionParticipantInput]?.find(
    (input) => input.identity.type === "profile",
  )?.identity;
  return identity?.type === "profile" ? identity.id : undefined;
}

export function isSessionPersonalBootstrapTurn(ctx: SessionParticipantInputContext): boolean {
  if (
    ctx.InternalTurnSource !== undefined ||
    ctx.InputProvenance?.kind === "inter_session" ||
    ctx.InputProvenance?.kind === "internal_system"
  ) {
    // Isolated cron sessions keep shared defaults; wakes in other sessions keep their selection.
    return !isCronSessionKey(ctx.SessionKey);
  }
  // Unqualified external turns are told to withhold the session's personal instructions.
  return (
    (!ctx.InputProvenance || ctx.InputProvenance.kind === "external_user") &&
    Boolean(ctx[sessionParticipantInput]?.length)
  );
}

/**
 * Personal profiles for one turn. sessionUserProfileId is the session's selected human, a
 * session fact that keys its prompt series; isolated cron sessions keep shared defaults.
 * bootstrapUserProfileId repeats the selection only when this turn's sender qualifies.
 */
export function resolveTurnPersonalProfiles(
  sessionKey: string | undefined,
  entry: Parameters<typeof sessionPersonalProfileId>[0],
  senderQualifies: boolean,
): { bootstrapUserProfileId?: string; sessionUserProfileId?: string } {
  return {
    bootstrapUserProfileId: senderQualifies ? sessionPersonalProfileId(entry) : undefined,
    sessionUserProfileId: isCronSessionKey(sessionKey)
      ? undefined
      : sessionPersonalProfileId(entry),
  };
}

/** An unqualified transport sender remains an observation, never a Gateway profile. */
export function prepareChannelParticipantObservation(ctx: SessionParticipantInputContext): void {
  const channel = ctx.Provider ?? ctx.Surface;
  if (
    ctx[sessionParticipantInput] ||
    !ctx.SenderId ||
    channel === "webchat" ||
    ctx.InternalTurnSource !== undefined ||
    (ctx.InputProvenance && ctx.InputProvenance.kind !== "external_user")
  ) {
    return;
  }
  prepareSessionParticipantInput(ctx, {
    type: "observation",
    pluginId: channel ?? null,
    accountId: ctx.AccountId ?? null,
    senderKind: ctx.SenderIsBot === true ? "bot" : ctx.SenderIsBot === false ? "human" : "unknown",
    id: ctx.SenderId,
  });
}
