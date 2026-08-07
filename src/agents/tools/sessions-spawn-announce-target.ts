import { optionalStringEnum } from "../schema/typebox.js";
import { SUBAGENT_ANNOUNCE_TARGETS } from "../subagent-announce-target.types.js";

export function sessionsSpawnAnnounceTargetSchema() {
  return optionalStringEnum(SUBAGENT_ANNOUNCE_TARGETS, {
    description:
      'Native completion routing. Set "parent" to wake the requester session without automatic external delivery; omit to preserve the normal parent-first completion path.',
  });
}

export function readSessionsSpawnAnnounceTarget(params: { announceTarget?: unknown }) {
  return params.announceTarget === "parent" ? params.announceTarget : undefined;
}
