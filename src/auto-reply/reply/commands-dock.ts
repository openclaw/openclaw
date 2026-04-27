import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { getChatCommands } from "../commands-registry.data.js";
import { resolveCommandSurfaceChannel } from "./channel-context.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

const DOCK_PREFIX = "/dock-";

function resolveLinkedTargetPeerId(
  identityLinks: Record<string, string[]> | undefined,
  sourceChannel: string,
  sourcePeerId: string,
  targetChannel: string,
): string | null {
  if (!identityLinks) {
    return null;
  }
  const rawPeer = sourcePeerId.toLowerCase().trim();
  const scopedPeer = `${sourceChannel}:${rawPeer}`;
  const targetPrefix = `${targetChannel}:`;
  for (const ids of Object.values(identityLinks)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    const normalizedIds = ids.map((id) => (typeof id === "string" ? id.toLowerCase().trim() : ""));
    if (!normalizedIds.includes(rawPeer) && !normalizedIds.includes(scopedPeer)) {
      continue;
    }
    for (const id of normalizedIds) {
      if (id.startsWith(targetPrefix)) {
        return id.slice(targetPrefix.length);
      }
    }
  }
  return null;
}

export const handleDockCommand: CommandHandler = async (params, _allowTextCommands) => {
  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(DOCK_PREFIX)) {
    return null;
  }

  const targetChannelRaw = normalizeOptionalLowercaseString(
    normalized.slice(DOCK_PREFIX.length).split(" ")[0],
  );
  if (!targetChannelRaw) {
    return null;
  }

  // Confirm it corresponds to a registered dock command so we don't swallow
  // unrelated commands that happen to start with /dock-
  const isDock = getChatCommands().some(
    (cmd) => cmd.key === `dock:${targetChannelRaw}` && cmd.category === "docks",
  );
  if (!isDock) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  const sourceChannel = resolveCommandSurfaceChannel(params);
  const sourcePeerId = normalizeOptionalString(params.ctx.SenderId);

  if (!sourceChannel || !sourcePeerId) {
    return {
      shouldContinue: false,
      reply: { text: "Cannot dock: unable to resolve current channel identity." },
    };
  }

  if (sourceChannel === targetChannelRaw) {
    return {
      shouldContinue: false,
      reply: { text: `Already on ${targetChannelRaw}.` },
    };
  }

  const targetPeerId = resolveLinkedTargetPeerId(
    params.cfg.session?.identityLinks,
    sourceChannel,
    sourcePeerId,
    targetChannelRaw,
  );

  if (!targetPeerId) {
    return {
      shouldContinue: false,
      reply: {
        text: `Cannot dock to ${targetChannelRaw}: no identity link configured for this user. Add an entry under session.identityLinks in your config.`,
      },
    };
  }

  if (params.sessionEntry) {
    params.sessionEntry.lastChannel = targetChannelRaw;
    params.sessionEntry.lastTo = targetPeerId;
    await persistSessionEntry(params);
  }

  return {
    shouldContinue: false,
    reply: { text: `Switching replies to ${targetChannelRaw}.` },
  };
};
