import { optionalStringEnum } from "../schema/typebox.js";
import { SUBAGENT_ANNOUNCE_TARGETS } from "../subagent-announce-target.types.js";
import { SUBAGENT_SPAWN_CONTEXT_MODES } from "../subagent-spawn.types.js";

const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;

export function sessionsSpawnRoutingSchemas(spawnModes: readonly string[]) {
  return {
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description: "Native: omit/isolated clean; fork only needing requester transcript.",
    }),
    announceTarget: sessionsSpawnAnnounceTargetSchema(),
  };
}

function sessionsSpawnAnnounceTargetSchema() {
  return optionalStringEnum(SUBAGENT_ANNOUNCE_TARGETS, {
    description:
      'Native completion routing. Set "parent" to wake the requester session without automatic external delivery; omit to preserve the normal parent-first completion path.',
  });
}

export function readSessionsSpawnAnnounceTarget(params: { announceTarget?: unknown }) {
  return params.announceTarget === "parent" ? params.announceTarget : undefined;
}
