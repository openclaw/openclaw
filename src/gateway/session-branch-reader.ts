/**
 * Branch-aware message reading for sessions stored as append-only trees.
 *
 * The default `readSessionMessages()` reads every message entry from a JSONL
 * transcript, ignoring the tree structure.  When sessions use branching (edit,
 * regenerate, version-switch) the UI needs only the messages on the **current
 * branch** – the path from root to the active leaf.
 *
 * `readSessionBranchMessages()` opens the transcript via `SessionManager`,
 * walks the current branch and returns only those messages – decorated with the
 * same `__openclaw` metadata that `readSessionMessages` attaches.
 */

import fs from "node:fs";
import path from "node:path";
import { SessionManager, type SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { resolveSessionFilePath } from "../config/sessions.js";
import { stripCumulativeAssistantText } from "./session-cumulative-text.js";
import { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";

export type BranchMessageMeta = {
  id?: string;
  seq: number;
};

function attachMeta(message: unknown, meta: BranchMessageMeta): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  return { ...message, __openclaw: meta } as unknown;
}

/**
 * Resolve the transcript file path for a session.
 * Returns null if no file exists on disk.
 */
export function resolveTranscriptFilePath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;

  // Try resolveSessionFilePath first for explicit sessionFile
  if (sessionFile) {
    try {
      const sessionsDir = storePath ? path.dirname(storePath) : undefined;
      const resolved = resolveSessionFilePath(
        sessionId,
        { sessionFile },
        sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
      );
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // fall through to candidates
    }
  }

  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Read messages on the current branch of a session transcript.
 *
 * @param transcriptPath  Absolute path to the JSONL transcript file.
 * @param leafId          Optional leaf entry id.  When provided only the path
 *                        from root to this entry is returned.  When omitted the
 *                        natural (last-appended) leaf is used.
 */
export function readSessionBranchMessages(
  transcriptPath: string,
  leafId?: string | null,
): unknown[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  try {
    const manager = SessionManager.open(transcriptPath);
    const branch = manager.getBranch(leafId ?? undefined);
    const messages: unknown[] = [];
    let seq = 0;

    for (const entry of branch) {
      if (entry.type === "message") {
        seq += 1;
        const msgEntry = entry;
        messages.push(
          attachMeta(msgEntry.message, {
            id: entry.id,
            seq,
          }),
        );
      }
      if (entry.type === "compaction") {
        seq += 1;
        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Date.now();
        messages.push({
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          timestamp: Number.isFinite(ts) ? ts : Date.now(),
          __openclaw: {
            kind: "compaction",
            id: entry.id,
            seq,
          },
        });
      }
    }
    return stripCumulativeAssistantText(messages);
  } catch {
    return [];
  }
}

/**
 * Get all direct children of a given entry id that are message entries.
 * Useful for version history – each child of a user message represents a
 * different version of the assistant reply.
 *
 * Returns an array of `{ entryId, message, isActive }` tuples.
 */
export function getEntryVersions(
  transcriptPath: string,
  parentEntryId: string,
  activeLeafId?: string | null,
): Array<{ entryId: string; message: unknown; isActive: boolean }> {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  try {
    const manager = SessionManager.open(transcriptPath);
    const children = manager.getChildren(parentEntryId);
    const effectiveLeaf = activeLeafId ?? manager.getLeafId();

    // Determine which child is on the active branch by walking from leaf to root
    const activeBranch = new Set<string>();
    if (effectiveLeaf) {
      for (const entry of manager.getBranch(effectiveLeaf)) {
        activeBranch.add(entry.id);
      }
    }

    return children
      .filter((child): child is SessionMessageEntry => child.type === "message")
      .map((child) => ({
        entryId: child.id,
        message: child.message,
        isActive: activeBranch.has(child.id),
      }));
  } catch {
    return [];
  }
}

/**
 * Find the deepest leaf reachable from an entry by always following the last child.
 */
export function findBranchTip(transcriptPath: string, entryId: string): string | null {
  if (!fs.existsSync(transcriptPath)) {
    return null;
  }
  try {
    const manager = SessionManager.open(transcriptPath);
    let current = entryId;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const children = manager.getChildren(current);
      if (children.length === 0) {
        return current;
      }
      // Follow the last child (most recently appended)
      current = children[children.length - 1].id;
    }
  } catch {
    return null;
  }
}
