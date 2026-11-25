import type { SessionCreatedActor as ProtocolSessionCreatedActor } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionsListResult } from "../api/types.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { takeGraphemes } from "./graphemes.ts";

export type SessionCreatedActor = ProtocolSessionCreatedActor;
export type SessionOwnerOption = NonNullable<SessionsListResult["owners"]>[number];

export function sessionSelfOwner(
  self: AuthenticatedUser | null | undefined,
): SessionOwnerOption | null {
  return self
    ? {
        type: "human",
        id: self.id,
        identity: { type: "profile", id: self.id },
        label: self.name,
        avatarUrl: self.avatarUrl,
      }
    : null;
}

export function sessionOwnerInitials(owner: SessionCreatedActor): string {
  const source = owner.label?.trim() || owner.id?.trim() || "";
  if (!source) {
    return "";
  }
  const parts = source
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  // Grapheme clusters, not UTF-16 units or bare code points: emoji display names
  // must render their complete visible initial (no lone surrogates or split ZWJ sequences).
  const firstChar = (value: string | undefined): string => (value ? takeGraphemes(value, 1) : "");
  const initials = (firstChar(parts[0]) + firstChar(parts[1])).toUpperCase();
  return initials || firstChar(source).toUpperCase();
}
