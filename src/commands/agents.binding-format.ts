// Human-readable formatting for agent routing binding match criteria.
import { createHash } from "node:crypto";
import type { AgentRouteBinding } from "../config/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type PublicBindingMatch = Omit<AgentRouteBinding["match"], "peer"> & {
  peer?: {
    kind: NonNullable<AgentRouteBinding["match"]["peer"]>["kind"];
    idHash: string;
    redacted: true;
  };
};

function routePeerHash(binding: AgentRouteBinding): string | null {
  const match = binding.match;
  if (!match.peer) {
    return null;
  }
  const accountId = match.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const identity = `${match.channel}:${accountId}:${match.peer.kind}:${match.peer.id}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

export function redactBindingMatchForOutput(binding: AgentRouteBinding): PublicBindingMatch {
  const match = binding.match;
  const redacted: PublicBindingMatch = {
    channel: match.channel,
    ...(match.accountId ? { accountId: match.accountId } : {}),
    ...(match.guildId ? { guildId: match.guildId } : {}),
    ...(match.teamId ? { teamId: match.teamId } : {}),
    ...(match.roles?.length ? { roles: [...match.roles] } : {}),
  };
  const idHash = routePeerHash(binding);
  if (match.peer && idHash) {
    redacted.peer = { kind: match.peer.kind, idHash, redacted: true };
  }
  return redacted;
}

/** Render one route binding as a compact CLI line fragment. */
export function describeBinding(binding: AgentRouteBinding): string {
  const match = binding.match;
  const parts = [match.channel];
  if (match.accountId) {
    parts.push(`accountId=${match.accountId}`);
  }
  if (match.peer) {
    const idHash = routePeerHash(binding);
    parts.push(`peer=${match.peer.kind}:sha256:${idHash ?? "redacted"}`);
  }
  if (match.guildId) {
    parts.push(`guild=${match.guildId}`);
  }
  if (match.teamId) {
    parts.push(`team=${match.teamId}`);
  }
  if (match.roles?.length) {
    parts.push(`roles=${match.roles.join(",")}`);
  }
  return parts.join(" ");
}
