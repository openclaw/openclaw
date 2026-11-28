import type { SessionTreeEntry } from "@openclaw/agent-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptTerminalModel } from "../../sessions/transcript-terminal-model.js";

const COMPACTION_ACTIVITY = "openclaw.context-compaction";
const CODEX_MIRROR_PREFIX = "codex-app-server:";

/** Match a compaction to the latest uninterrupted Codex thread epoch on the active branch. */
export function selectUncoveredCodexCompaction<T extends SessionTreeEntry>(
  entries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry,
): boolean {
  const resetIndex = entries.findLastIndex((entry) => entry.type === "reset");
  const branch = entries.slice(resetIndex + 1);
  const candidates = branch.flatMap((entry, index) =>
    entry.type === "message" &&
    entry.message.role === "custom" &&
    entry.message.customType === COMPACTION_ACTIVITY
      ? [{ entry, index }]
      : [],
  );
  if (!candidates.length) {
    return false;
  }

  const cutIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const cutEntry = branch[cutIndex];
  const cut = cutEntry && readEntry(cutEntry);
  const verifiedCut =
    cut?.type === "compaction" &&
    Boolean(cut.summary.trim()) &&
    branch.slice(0, cutIndex).some((entry) => entry.id === cut.firstKeptEntryId)
      ? cutIndex
      : -1;
  if (candidates.at(-1)!.index <= verifiedCut) {
    return false;
  }

  const terminals = new Map<string, string>();
  let threadId: string | undefined;
  let firstTerminalIndex = branch.length;
  let epochStart = 0;
  for (let index = branch.length - 1; index >= 0; index--) {
    const candidate = branch[index];
    if (
      candidate?.type !== "message" ||
      candidate.message.role !== "assistant" ||
      (candidate.message.stopReason !== "stop" && candidate.message.stopReason !== "length")
    ) {
      continue;
    }
    const entry = readEntry(candidate);
    const message = entry.type === "message" ? asOptionalRecord(entry.message) : undefined;
    if (!message || message.display === false || message.excludeFromContext === true) {
      continue;
    }
    const meta = asOptionalRecord(message["__openclaw"]);
    if (meta?.mirrorOrigin !== undefined && meta.runTerminal !== true) {
      continue;
    }
    const terminal = readSessionTranscriptTerminalModel(entry);
    const identity = typeof meta?.mirrorIdentity === "string" ? meta.mirrorIdentity : "";
    const key = typeof message.idempotencyKey === "string" ? message.idempotencyKey : "";
    const suffix = `:${identity}`;
    const candidateThread =
      terminal &&
      meta?.mirrorOrigin === "codex-app-server" &&
      meta.runTerminal === true &&
      identity.endsWith(":assistant") &&
      identity.length > ":assistant".length &&
      key.startsWith(CODEX_MIRROR_PREFIX) &&
      key.endsWith(suffix)
        ? key.slice(CODEX_MIRROR_PREFIX.length, -suffix.length)
        : undefined;
    if (!terminal || !candidateThread || (threadId && candidateThread !== threadId)) {
      // A newer embedded, unattributed or different-thread terminal ends the epoch.
      epochStart = index + 1;
      break;
    }
    threadId = candidateThread;
    firstTerminalIndex = index;
    if (!terminals.has(identity)) {
      terminals.set(identity, terminal.runId);
    }
  }
  if (!threadId) {
    return false;
  }

  return candidates.some(({ entry, index }) => {
    if (index < epochStart || index <= verifiedCut) {
      return false;
    }
    const activity = readEntry(entry);
    const value = activity.type === "message" ? asOptionalRecord(activity.message) : undefined;
    const details = asOptionalRecord(value?.details);
    if (
      details?.backend !== "codex-app-server" ||
      details.kind !== "context_compaction" ||
      details.threadId !== threadId ||
      typeof details.turnId !== "string" ||
      !details.turnId ||
      typeof details.itemId !== "string" ||
      !details.itemId ||
      value?.excludeFromContext !== true ||
      value.idempotencyKey !==
        `codex-context-compaction:${threadId}:${details.turnId}:${details.itemId}`
    ) {
      return false;
    }
    // Automatic receipts can precede the terminal from their turn. Manual
    // receipts own a separate turn and must follow a terminal in this epoch.
    return details.trigger === "manual"
      ? index > firstTerminalIndex
      : typeof details.runId === "string" &&
          terminals.get(`${details.turnId}:assistant`) === details.runId;
  });
}
