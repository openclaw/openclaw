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
import {
  MARK_LANGUAGE_CHINESE,
  MARK_LANGUAGE_ENGLISH,
  MARK_PRESETS,
  MARK_SEPARATOR,
  type MarkLanguage,
  type MarkPreset,
} from "../commands-mark.shared.js";
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

function resolveMarkLanguage(entry: SessionEntry | undefined): MarkLanguage {
  return entry?.markLanguage === MARK_LANGUAGE_ENGLISH
    ? MARK_LANGUAGE_ENGLISH
    : MARK_LANGUAGE_CHINESE;
}

function markText(language: MarkLanguage, chinese: string, english: string): string {
  return language === MARK_LANGUAGE_ENGLISH ? english : chinese;
}

function stripMarkPrefix(label: string): string {
  const separatorIndex = label.indexOf(MARK_SEPARATOR);
  if (separatorIndex === -1) {
    return label;
  }
  const symbol = label.slice(0, separatorIndex);
  return MARK_PRESETS.some((preset) => preset.symbol === symbol)
    ? label.slice(separatorIndex + MARK_SEPARATOR.length)
    : label;
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

function formatPresetList(language: MarkLanguage): string {
  const lines = [
    markText(
      language,
      "可用标记（使用 /mark <符号|名称|序号|别名>）：",
      "Available marks (use /mark <symbol|id|index|alias>):",
    ),
  ];
  for (const preset of MARK_PRESETS) {
    lines.push(
      `  ${preset.symbol}  [${preset.index}] ${preset.id}  (${preset.aliases.join(", ")})`,
    );
  }
  lines.push(
    markText(language, "  /mark clear  →  清除标记", "  /mark clear  →  remove mark"),
    markText(language, "  /mark english  →  切换英文", "  /mark 中文  →  switch to Chinese"),
  );
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

  const currentEntry =
    loadSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath }) ??
    params.sessionEntry;
  const language = resolveMarkLanguage(currentEntry);
  const arg = parsed.arg;
  const argLower = normalizeOptionalLowercaseString(arg) ?? "";
  if (!arg || argLower === "list") {
    return markReply(formatPresetList(language));
  }

  const requestedLanguage: MarkLanguage | undefined =
    argLower === MARK_LANGUAGE_ENGLISH
      ? MARK_LANGUAGE_ENGLISH
      : arg === MARK_LANGUAGE_CHINESE
        ? MARK_LANGUAGE_CHINESE
        : undefined;
  const isClear = argLower === "clear";
  const preset = isClear || requestedLanguage ? undefined : matchMarkPreset(arg);
  if (!isClear && !requestedLanguage && !preset) {
    return markReply(
      markText(
        language,
        `❌ 没有匹配“${arg}”的标记。请输入 /mark 查看选项。`,
        `❌ No mark matches “${arg}”. Enter /mark to see options.`,
      ),
    );
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
      if (requestedLanguage) {
        entry.markLanguage = requestedLanguage;
      } else {
        const base = stripMarkPrefix(normalizeOptionalString(entry.label) ?? "");
        if (isClear) {
          if (base) {
            entry.label = base;
          } else {
            delete entry.label;
          }
        } else if (preset) {
          entry.label = `${preset.symbol}${MARK_SEPARATOR}${base}`;
        }
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
  const nextLanguage = requestedLanguage ?? language;
  if (requestedLanguage) {
    return markReply(
      markText(nextLanguage, "✅ Mark 语言已切换为中文。", "✅ Mark language switched to English."),
    );
  }
  return isClear
    ? markReply(markText(nextLanguage, "✅ 标记已清除。", "✅ Mark cleared."))
    : markReply(
        markText(
          nextLanguage,
          `${preset?.symbol} 已标记为“${preset?.id}”。`,
          `${preset?.symbol} Marked as “${preset?.id}”.`,
        ),
      );
};
