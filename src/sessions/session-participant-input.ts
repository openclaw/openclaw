import type { MsgContext } from "../auto-reply/templating.js";
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
  // Unqualified external turns must still omit the overlay and restart the prompt series.
  return (
    (!ctx.InputProvenance || ctx.InputProvenance.kind === "external_user") &&
    Boolean(ctx[sessionParticipantInput]?.length)
  );
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
