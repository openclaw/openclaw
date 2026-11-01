import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

/** Captured logical/store identity. Incarnation is evidence, never live authorization. */
export type SessionTarget = Readonly<{
  storeScope: string;
  /** Prepared storage observation only; never scheduling identity or live authority. */
  physicalStorePath?: string;
  sessionKey: string;
  aliases: readonly string[];
  agentId: string | undefined;
  incarnation: string | undefined;
}>;

/** Matches the physical and agent owner dimensions of two captured targets. */
export function sessionTargetOwnersMatch(a: SessionTarget, b: SessionTarget): boolean {
  return (
    a.storeScope === b.storeScope &&
    (!a.agentId || !b.agentId || normalizeAgentId(a.agentId) === normalizeAgentId(b.agentId))
  );
}

export function captureSessionTarget(params: {
  storeScope: string;
  physicalStorePath?: string;
  sessionKey: string;
  aliases?: Iterable<string | undefined>;
  agentId?: string;
  incarnation?: string;
}): SessionTarget {
  const storeScope = params.storeScope.trim();
  const sessionKey = params.sessionKey.trim();
  if (!storeScope || !sessionKey) {
    throw new Error("Session target requires store scope and canonical key");
  }
  return Object.freeze({
    storeScope,
    ...(params.physicalStorePath ? { physicalStorePath: params.physicalStorePath } : {}),
    sessionKey,
    aliases: Object.freeze(
      [
        ...new Set(
          [sessionKey, ...(params.aliases ?? []), params.incarnation].flatMap((value) =>
            value?.trim() ? [value.trim()] : [],
          ),
        ),
      ].toSorted(),
    ),
    agentId: params.agentId ?? parseAgentSessionKey(sessionKey)?.agentId,
    incarnation: params.incarnation,
  });
}

/** Adapter input for physical owners that already captured their complete identity set. */
export type IdentityTarget = {
  scope: string;
  identities: Iterable<string | undefined>;
  agentId?: string;
};
export type TargetInput = { target: SessionTarget } | IdentityTarget;
export function targetFrom(input: TargetInput): SessionTarget {
  if ("target" in input) {
    return input.target;
  }
  const aliases = [...input.identities].flatMap((value) => (value?.trim() ? [value.trim()] : []));
  const sessionKey = aliases.find((key) => key.startsWith("agent:")) ?? aliases[0];
  if (!sessionKey) {
    throw new Error("Session target requires an identity");
  }
  return captureSessionTarget({
    storeScope: input.scope,
    sessionKey,
    aliases,
    agentId: input.agentId,
  });
}
