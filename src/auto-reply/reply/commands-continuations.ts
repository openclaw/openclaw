// Continuation (karmaterminal): /continuations lists the session's live continuation elections and
// cancels the ones the owner names: the explicit "stop the search" that /new and /reset never
// perform implicitly.
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import { resolveCommandSourceSessionKey } from "./command-source-session-key.js";
import type { CommandHandler } from "./commands-types.js";

const USAGE = "Usage: /continuations [list] | /continuations cancel <id> [id...]";
const SUMMARY_PREVIEW_CHARS = 80;

function preview(text: string | undefined): string {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) {
    return "";
  }
  const clipped =
    flat.length > SUMMARY_PREVIEW_CHARS ? `${flat.slice(0, SUMMARY_PREVIEW_CHARS - 1)}…` : flat;
  return ` · ${JSON.stringify(clipped)}`;
}

async function listLiveElections(sessionKey: string): Promise<string> {
  const [{ listContinuationRecords }, { decodeDelegateState }, { decodeWorkState }] =
    await Promise.all([
      import("../continuation/custody/custody-store.js"),
      import("../continuation/delegate-flow-store.js"),
      import("../continuation/work-flow-state.js"),
    ]);
  const live = (
    await listContinuationRecords({ ownerSessionKey: sessionKey, statuses: ["queued", "running"] })
  ).filter((record) => record.cancelRequestedAt === undefined);
  if (live.length === 0) {
    return "No live continuation elections for this session.";
  }
  const lines = live.map((record) => {
    const summary =
      record.kind === "work" ? decodeWorkState(record)?.reason : decodeDelegateState(record)?.task;
    const due = record.dueAt === undefined ? "" : ` · due ${new Date(record.dueAt).toISOString()}`;
    return `• ${record.recordId} · ${record.kind} · ${record.status}${due}${preview(summary)}`;
  });
  return [
    `Continuation elections (${live.length} live):`,
    ...lines,
    "Cancel with /continuations cancel <id> [id...].",
  ].join("\n");
}

async function cancelNamedElections(sessionKey: string, recordIds: string[]): Promise<string> {
  const { cancelOwnedContinuationRecords, SessionContinuationResetError } =
    await import("../continuation/session-reset.js");
  let receipt: Awaited<ReturnType<typeof cancelOwnedContinuationRecords>>;
  try {
    receipt = await cancelOwnedContinuationRecords({ ownerSessionKey: sessionKey, recordIds });
  } catch (error) {
    if (error instanceof SessionContinuationResetError) {
      return `⚠️ Cancel did not complete: ${error.message}`;
    }
    throw error;
  }
  const lines = receipt.map((entry) => {
    const was = entry.kind && entry.status ? ` · ${entry.kind} · was ${entry.status}` : "";
    const child = entry.childSessionKey ? ` (child ${entry.childSessionKey})` : "";
    return `• ${entry.recordId}${was} → ${entry.outcome}${child}`;
  });
  return ["Continuation cancel receipt:", ...lines].join("\n");
}

export const handleContinuationsCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/continuations",
    match: (body) => {
      const rest = matchCommandPrefix(body, "/continuations");
      if (rest === null) {
        return null;
      }
      const [action = "list", ...recordIds] = rest.split(/\s+/).filter(Boolean);
      return { action: action.toLowerCase(), recordIds };
    },
    // Listing only reads; ending an election the session's agent made is the owner's call.
    ownerOnly: (_params, match) => match.action === "cancel",
    silentUnauthorized: true,
  },
  async (params, { action, recordIds }) => {
    const sessionKey = resolveCommandSourceSessionKey(params);
    if (!sessionKey) {
      return commandReply("⚠️ Missing session key.");
    }
    if (action === "list" && recordIds.length === 0) {
      return commandReply(await listLiveElections(sessionKey));
    }
    if (action === "cancel" && recordIds.length > 0) {
      return commandReply(await cancelNamedElections(sessionKey, recordIds));
    }
    return commandReply(USAGE);
  },
);
