import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  getSessionEntry,
  resolveSessionStoreEntry,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { deriveSessionTitle } from "../../gateway/session-utils.js";
import {
  applySessionTitle,
  getSessionTitleFromEntry,
  parseSessionTitle,
  sessionTitlesEqual,
} from "../../sessions/session-label.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const NAME_COMMAND_PREFIX = "/name";
const NAME_CLEAR_FLAG = "--clear";

export function parseNameCommand(raw: string): { title: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(commandToken) !== NAME_COMMAND_PREFIX) {
    return null;
  }
  const argText = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  return { title: argText };
}

function nameReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function syncNameSessionEntry(params: HandleCommandsParams): void {
  if (!params.sessionStore || !params.sessionKey || !params.storePath) {
    return;
  }
  const entry = getSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (!entry) {
    return;
  }
  params.sessionStore[params.sessionKey] = entry;
  params.sessionEntry = entry;
}

type NameWriteResult =
  | {
      ok: true;
      title: string | undefined;
      sessionKey: string;
      entry: SessionEntry;
      hadLegacyAliases: boolean;
      cleared: boolean;
    }
  | { ok: false; error: string };

export const handleNameCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseNameCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/name");
  if (unauthorized) {
    return unauthorized;
  }

  if (!params.storePath || !params.sessionKey) {
    return nameReply("Naming is not available for this session.");
  }

  const rawTitle = normalizeOptionalString(parsed.title);

  // No argument: surface the current name plus a deterministic suggestion
  // derived locally (no LLM, no mutation). Apply it with `/name <title>`.
  if (!rawTitle) {
    const entry =
      getSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath }) ??
      params.sessionEntry;
    const current = getSessionTitleFromEntry(entry);
    const suggestion = deriveSessionTitle(entry);
    const lines: string[] = [];
    lines.push(current ? `Current session name: ${current}` : "This session has no custom name yet.");
    if (suggestion && suggestion !== current) {
      lines.push(`Suggested name: ${suggestion}`);
    }
    lines.push("Use /name <title> to set a name, or /name --clear to remove it.");
    return nameReply(lines.join("\n"));
  }

  const storePath = params.storePath;
  const sessionKey = params.sessionKey;
  const shouldClear = rawTitle === NAME_CLEAR_FLAG;

  // Resolve through the store helper so renames land on the canonical entry even
  // when the store still holds a legacy/case-folded key alias. The canonical
  // title is mirrored to legacy label so older API/UI selectors continue to work.
  const result = await updateSessionStore<NameWriteResult>(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      // Native slash may invoke `/name` before the fast path persists the entry.
      // Seed a copy under the canonical key without mutating params on failed writes.
      const entry =
        resolved.existing ?? (params.sessionEntry ? { ...params.sessionEntry } : undefined);
      if (!entry) {
        return { ok: false, error: "no active session to name" };
      }

      const aliasKeys = new Set<string>([resolved.normalizedKey, ...resolved.legacyKeys]);
      if (shouldClear) {
        applySessionTitle(entry, null);
      } else {
        const validated = parseSessionTitle(rawTitle);
        if (!validated.ok) {
          return { ok: false, error: validated.error };
        }
        for (const [key, other] of Object.entries(store)) {
          if (!aliasKeys.has(key) && sessionTitlesEqual(getSessionTitleFromEntry(other), validated.title)) {
            return { ok: false, error: `title already in use: ${validated.title}` };
          }
        }
        applySessionTitle(entry, validated.title);
      }

      entry.updatedAt = Math.max(entry.updatedAt ?? 0, Date.now());
      // Persist through the canonical key and drop any legacy/case-folded
      // aliases, mirroring `persistResolvedSessionEntry`.
      store[resolved.normalizedKey] = entry;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return {
        ok: true,
        title: getSessionTitleFromEntry(entry),
        sessionKey: resolved.normalizedKey,
        entry,
        hadLegacyAliases: resolved.legacyKeys.length > 0,
        cleared: shouldClear,
      };
    },
    {
      skipSaveWhenResult: (value) => !value.ok,
      resolveSingleEntryPersistence: (value) =>
        value.ok && !value.hadLegacyAliases
          ? { sessionKey: value.sessionKey, entry: value.entry }
          : null,
    },
  );

  if (!result.ok) {
    return nameReply(`Couldn't rename the session: ${result.error}`);
  }
  syncNameSessionEntry(params);
  markCommandSessionMetadataChanged(params);
  if (result.cleared) {
    return nameReply("Session name cleared.");
  }
  return nameReply(`Session renamed to ${result.title}.`);
};
