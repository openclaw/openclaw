import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  applySessionPatchProjection,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { deriveSessionTitle } from "../../gateway/session-utils.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { commandReply as nameReply, defineAuthorizedTextCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { matchSlashCommandToken } from "./commands-slash-parse.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const NAME_COMMAND_PREFIX = "/name";

function syncNameSessionEntry(params: HandleCommandsParams): void {
  if (!params.sessionStore || !params.sessionKey || !params.storePath) {
    return;
  }
  const entry = loadSessionEntryReadOnly({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!entry) {
    return;
  }
  params.sessionStore[params.sessionKey] = entry;
  params.sessionEntry = entry;
}

export const handleNameCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/name", match: (body) => matchSlashCommandToken(body, NAME_COMMAND_PREFIX) },
  async (params, rawTitle) => {
    if (!params.storePath || !params.sessionKey) {
      return nameReply("Naming is not available for this session.");
    }

    const title = normalizeOptionalString(rawTitle);

    // No argument: surface the current name plus a deterministic suggestion
    // derived locally (no LLM, no mutation). Apply it with `/name <title>`.
    if (!title) {
      const entry =
        loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath: params.storePath }) ??
        params.sessionEntry;
      const current = normalizeOptionalString(entry?.label);
      const suggestionEntry = entry ? { ...entry, label: undefined } : undefined;
      const suggestion = deriveSessionTitle(suggestionEntry);
      const lines: string[] = [];
      lines.push(
        current ? `Current session name: ${current}` : "This session has no custom name yet.",
      );
      if (suggestion && suggestion !== current) {
        lines.push(`Suggested name: ${suggestion}`);
      }
      lines.push("Use /name <title> to set a name (mirrors the session manager).");
      return nameReply(lines.join("\n"));
    }

    const storePath = params.storePath;
    const sessionKey = normalizeStoreSessionKey(params.sessionKey);
    // Reuse the canonical label validation (`parseSessionLabel`) and the same
    // cross-store uniqueness rule enforced by the web/admin `sessions.patch`
    // path so chat naming behaves identically to the session manager.
    const result = await applySessionPatchProjection<{ ok: false; error: string }>({
      storePath,
      resolveTarget: () => ({ primaryKey: sessionKey, candidateKeys: [sessionKey] }),
      project: ({ existingEntry, isLabelInUse }) => {
        // Native slash may invoke `/name` before the fast path persists the entry.
        // Seed a copy under the canonical key without mutating params on failed writes.
        const entry =
          existingEntry ?? (params.sessionEntry ? { ...params.sessionEntry } : undefined);
        if (!entry) {
          return { ok: false, error: "no active session to name" };
        }
        const validated = parseSessionLabel(title);
        if (!validated.ok) {
          return { ok: false, error: validated.error };
        }
        if (isLabelInUse(validated.label)) {
          return { ok: false, error: `label already in use: ${validated.label}` };
        }
        entry.label = validated.label;
        entry.updatedAt = Math.max(entry.updatedAt ?? 0, Date.now());
        return {
          ok: true,
          entry,
        };
      },
    });

    if (!result.ok) {
      return nameReply(`Couldn't rename the session: ${result.error}`);
    }
    syncNameSessionEntry(params);
    markCommandSessionMetadataChanged(params);
    return nameReply(`✅ Session renamed to “${result.entry.label}”.`);
  },
);
