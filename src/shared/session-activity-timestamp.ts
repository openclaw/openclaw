import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";

type SessionActivityClock = {
  lastActivityAt?: number;
  lastInteractionAt?: number;
  updatedAt?: number | null;
  createdAt?: number;
};

export function sessionActivityTimestamp(row: SessionActivityClock): number {
  const lastActivityAt = asPositiveFiniteNumber(row.lastActivityAt);
  const lastInteractionAt = asPositiveFiniteNumber(row.lastInteractionAt);
  if (lastActivityAt !== undefined || lastInteractionAt !== undefined) {
    return Math.max(lastActivityAt ?? 0, lastInteractionAt ?? 0);
  }
  // Older sessions may predate the activity clocks; metadata is only their fallback.
  return asPositiveFiniteNumber(row.updatedAt) ?? asPositiveFiniteNumber(row.createdAt) ?? 0;
}
