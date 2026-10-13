import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import { normalizeChatChannelId } from "../channels/ids.js";
import { CONFIG_BACKUP_COUNT } from "../config/backup-rotation.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import { createCommandOwnerChannelResolver } from "./doctor-command-owner.js";
import {
  containsAuthoredInclude,
  readDoctorConfigBackup,
} from "./doctor/shared/include-migration-ownership.js";

function withoutLegacyOwnerKind(entry: unknown): unknown {
  const legacy = typeof entry === "string" ? /^([^:]+):user:([^:\s*]+)$/i.exec(entry.trim()) : null;
  const channel = legacy && normalizeChatChannelId(legacy[1]);
  return channel && legacy ? `${channel}:${legacy[2]}` : entry;
}

/** Recover only a recorded direct-user kind for an owner whose identity still matches. */
export function recoverCommandOwnerTargetKinds(params: {
  config: OpenClawConfig;
  snapshot: Pick<ConfigFileSnapshot, "path" | "parsed">;
}): { config: OpenClawConfig; changes: string[]; warnings: string[] } {
  const { config, snapshot } = params;
  const result: { config: OpenClawConfig; changes: string[]; warnings: string[] } = {
    config,
    changes: [],
    warnings: [],
  };
  const owners = config.commands?.ownerAllowFrom;
  if (
    !owners?.length ||
    !resolveHeartbeatAgents(config).some(
      ({ heartbeat }) =>
        (heartbeat?.target === undefined || heartbeat.target === "owner") &&
        resolveHeartbeatIntervalMs(config, undefined, heartbeat),
    )
  ) {
    return result;
  }
  const repairs = new Map<number, string>();
  const resolveChannel = createCommandOwnerChannelResolver(config);
  for (const [index, entry] of owners.entries()) {
    const bare = typeof entry === "string" ? /^([^:]+):([^:\s*]+)$/.exec(entry.trim()) : null;
    const channel = bare && normalizeChatChannelId(bare[1]);
    const id = bare?.[2];
    if (!channel || !id) {
      continue;
    }
    const messaging = resolveChannel(channel)?.messaging;
    if (
      messaging?.directTargetStyle === "user-prefixed" &&
      messaging.inferTargetChatType?.({ to: id }) !== "direct" &&
      messaging.inferTargetChatType?.({ to: `user:${id}` }) === "direct"
    ) {
      repairs.set(index, `${channel}:user:${id}`);
    }
  }
  if (repairs.size === 0) {
    return result;
  }
  const ownerAllowFrom = [...owners];

  // Compare the whole authored owner list, including order. Never search through
  // an intervening identity change or resolve historical includes with today's files.
  if (!containsAuthoredInclude(snapshot.parsed)) {
    for (let index = 0; index < CONFIG_BACKUP_COUNT; index++) {
      const backupPath = `${snapshot.path}.bak${index === 0 ? "" : `.${index}`}`;
      let backup: unknown;
      try {
        const raw = readDoctorConfigBackup(backupPath);
        if (raw === undefined) {
          continue;
        }
        backup = JSON5.parse(raw);
      } catch {
        result.warnings.push(`Could not inspect ${backupPath} for command-owner target recovery.`);
        break;
      }
      const historical =
        isRecord(backup) && isRecord(backup.commands) ? backup.commands.ownerAllowFrom : undefined;
      if (
        containsAuthoredInclude(backup) ||
        !Array.isArray(historical) ||
        historical.length !== owners.length ||
        historical.some(
          (entry, position) =>
            entry !== owners[position] && withoutLegacyOwnerKind(entry) !== owners[position],
        )
      ) {
        break;
      }
      for (const [position, typed] of repairs) {
        if (historical[position] !== owners[position]) {
          ownerAllowFrom[position] = typed;
          repairs.delete(position);
          result.changes.push(
            `Restored commands.ownerAllowFrom[${position}] target kind from ${backupPath}.`,
          );
        }
      }
      if (result.changes.length) {
        result.config = { ...config, commands: { ...config.commands, ownerAllowFrom } };
        if (repairs.size === 0) {
          break;
        }
      }
    }
  }
  for (const [index, typed] of repairs) {
    result.warnings.push(
      `commands.ownerAllowFrom[${index}]=${JSON.stringify(owners[index])} cannot resolve a direct heartbeat owner route; heartbeats can skip with reason="no-route". No matching config backup proves the user target kind. After confirming this is your user ID, set commands.ownerAllowFrom[${index}] to ${JSON.stringify(typed)}. Doctor left this owner unchanged.`,
    );
  }
  return result;
}
