/** Handles /mark preset symbol commands for session labels. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  applySessionPatchProjection,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { MARK_PRESETS, MARK_SEPARATOR, type MarkPreset } from "../commands-mark.shared.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const MARK_COMMAND_PREFIX = "/mark";

function parseMarkCommand(raw: string): { arg: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/u);
  const token = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(token) !== MARK_COMMAND_PREFIX) {
    return null;
  }
  return { arg: commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim() };
}

function markReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function resolveUnmarkedLabel(entry: SessionEntry): string {
  return entry.sessionMark?.baseLabel ?? normalizeOptionalString(entry.label) ?? "";
}

function matchMarkPreset(arg: string): MarkPreset | undefined {
  const lower = arg.toLowerCase();
  return MARK_PRESETS.find(
    (preset) =>
      preset.symbol === arg ||
      preset.id.toLowerCase() === lower ||
      (/^\d+$/u.test(arg) && preset.index === Number(arg)) ||
      preset.aliases.some((alias) => alias.toLowerCase() === lower),
  );
}

function syncMarkSessionEntry(params: HandleCommandsParams): void {
  if (!params.sessionStore || !params.storePath) {
    return;
  }
  const entry = loadSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (!entry) {
    return;
  }
  params.sessionStore[params.sessionKey] = entry;
  params.sessionEntry = entry;
}

function formatPresetList(): string {
  const lines = ["Available marks (use /mark <symbol|id|index|alias>):"];
  for (const preset of MARK_PRESETS) {
    lines.push(
      `  ${preset.symbol}  [${preset.index}] ${preset.id}  (${preset.aliases.join(", ")})`,
    );
  }
  lines.push("  /mark clear  →  remove mark");
  return lines.join("\n");
}

export const handleMarkCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseMarkCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, MARK_COMMAND_PREFIX);
  if (unauthorized) {
    return unauthorized;
  }
  if (!params.storePath || !params.sessionKey) {
    return markReply("Mark is not available for this session.");
  }

  const arg = parsed.arg;
  const argLower = normalizeOptionalLowercaseString(arg) ?? "";
  if (!arg || argLower === "list") {
    return markReply(formatPresetList());
  }

  const isClear = argLower === "clear";
  const preset = isClear ? undefined : matchMarkPreset(arg);
  if (!isClear && !preset) {
    return markReply(`❌ No mark matches “${arg}”. Enter /mark to see options.`);
  }

  const sessionKey = normalizeStoreSessionKey(params.sessionKey);
  const result = await applySessionPatchProjection<{ ok: false; error: string }>({
    storePath: params.storePath,
    resolveTarget: () => ({ primaryKey: sessionKey, candidateKeys: [sessionKey] }),
    project: ({ existingEntry }) => {
      const entry = existingEntry ?? (params.sessionEntry ? { ...params.sessionEntry } : undefined);
      if (!entry) {
        return { ok: false, error: "no active session to mark" };
      }
      const base = resolveUnmarkedLabel(entry);
      if (isClear) {
        if (entry.sessionMark) {
          if (base) {
            entry.label = base;
          } else {
            delete entry.label;
          }
          delete entry.sessionMark;
        }
      } else if (preset) {
        entry.sessionMark = { symbol: preset.symbol, baseLabel: base };
        entry.label = `${preset.symbol}${MARK_SEPARATOR}${base}`;
      }
      entry.updatedAt = Math.max(entry.updatedAt ?? 0, Date.now());
      return { ok: true, entry };
    },
  });

  if (!result.ok) {
    return markReply(`Couldn't mark the session: ${result.error}`);
  }
  syncMarkSessionEntry(params);
  markCommandSessionMetadataChanged(params);
  return isClear
    ? markReply("✅ Mark cleared.")
    : markReply(`${preset?.symbol} Marked as “${preset?.id}”.`);
};
