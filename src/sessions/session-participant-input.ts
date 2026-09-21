import type { MsgContext } from "../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";

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

/** Personal bootstrap needs one unambiguous person, not the first contributor in a batch. */
export function readSessionInputBootstrapProfileId(
  ctx: SessionParticipantInputContext,
): string | undefined {
  if (
    ctx.InternalTurnSource !== undefined ||
    (ctx.InputProvenance && ctx.InputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const inputs = ctx[sessionParticipantInput];
  const first = inputs?.[0]?.identity;
  if (
    first?.type !== "profile" ||
    !inputs?.every(({ identity }) => identity.type === "profile" && identity.id === first.id)
  ) {
    return undefined;
  }
  return first.id;
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
