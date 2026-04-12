/**
 * Gateway RPC handlers for session-level message mutations:
 *
 *   sessions.fork             – Fork a session to a new one (optionally at a specific entry)
 *   sessions.messages.edit    – Edit a message by branching
 *   sessions.messages.delete  – Delete a turn by branching
 *   sessions.messages.versions – List version siblings for an entry
 *   sessions.messages.switch-version – Switch the active branch to a different version
 *   chat.regenerate           – Re-generate from the last user message
 *   chat.continue             – Continue from an assistant message / prefill
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { loadConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsForkParams,
  validateSessionsMessagesEditParams,
  validateSessionsMessagesDeleteParams,
  validateSessionsMessagesVersionsParams,
  validateSessionsMessagesSwitchVersionParams,
  validateChatRegenerateParams,
  validateChatContinueParams,
} from "../protocol/index.js";
import {
  resolveTranscriptFilePath,
  findBranchTip,
  getEntryVersions,
  readSessionBranchMessages,
} from "../session-branch-reader.js";
import { createCumulativeTextStripper as createCumulativeTextStripperLocal } from "../session-cumulative-text.js";
import { loadSessionEntry, resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { chatHandlers, pendingAssistantPrefill } from "./chat.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

// ── Helpers ──

function resolveTranscriptForSession(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  return resolveTranscriptFilePath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
}

function emitSessionsChanged(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: { sessionKey?: string; reason: string },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  context.broadcastToConnIds("sessions.changed", { ...payload, ts: Date.now() }, connIds, {
    dropIfSlow: true,
  });
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
}

/**
 * Walk from `startId` to the deepest leaf by always following the last child.
 * Returns the branch entries from root to that leaf, and the index of
 * `targetId` in the branch (or -1 if not found).
 */
function resolveBranchContainingEntry(
  manager: SessionManager,
  targetId: string,
): { branchEntries: ReturnType<SessionManager["getBranch"]>; targetIdx: number } {
  // Try the natural leaf first.
  let branchEntries = manager.getBranch(manager.getLeafId() ?? undefined);
  let targetIdx = branchEntries.findIndex((e) => e.id === targetId);
  if (targetIdx >= 0) {
    return { branchEntries, targetIdx };
  }
  // Entry is not on the natural branch — walk its children to the tip.
  let tipId = targetId;
  let children = manager.getChildren(tipId);
  while (children.length > 0) {
    tipId = children[children.length - 1].id;
    children = manager.getChildren(tipId);
  }
  branchEntries = manager.getBranch(tipId);
  targetIdx = branchEntries.findIndex((e) => e.id === targetId);
  return { branchEntries, targetIdx };
}

/**
 * Re-append entries from a previous branch onto the current position
 * of `manager`.  Entries that reference old entry IDs (compaction,
 * branch_summary, label) are skipped.
 */
function reappendTailEntries(
  manager: SessionManager,
  tailEntries: ReturnType<SessionManager["getBranch"]>,
): void {
  for (const tailEntry of tailEntries) {
    switch (tailEntry.type) {
      case "message":
        manager.appendMessage(
          tailEntry.message as Parameters<SessionManager["appendMessage"]>[0],
        );
        break;
      case "thinking_level_change":
        manager.appendThinkingLevelChange(tailEntry.thinkingLevel);
        break;
      case "model_change":
        manager.appendModelChange(tailEntry.provider, tailEntry.modelId);
        break;
      case "custom":
        manager.appendCustomEntry(tailEntry.customType, tailEntry.data);
        break;
      case "custom_message":
        manager.appendCustomMessageEntry(
          tailEntry.customType,
          tailEntry.content,
          tailEntry.display,
          tailEntry.details,
        );
        break;
      case "session_info":
        manager.appendSessionInfo(tailEntry.name ?? "");
        break;
      default:
        break;
    }
  }
}

// ── Handlers ──

export const sessionsMessagesHandlers: GatewayRequestHandlers = {
  // ─── Fork ───
  "sessions.fork": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsForkParams, "sessions.fork", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const sourceKey = p.key.trim();
    const { storePath, entry, canonicalKey: sourceCanonicalKey } = loadSessionEntry(sourceKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const sourceAgentId =
      resolveAgentIdFromSessionKey(sourceCanonicalKey) ?? resolveDefaultAgentId(cfg);
    const targetAgentId = normalizeAgentId(
      typeof p.agentId === "string" && p.agentId.trim() ? p.agentId : sourceAgentId,
    );

    const entryId = typeof p.entryId === "string" ? p.entryId.trim() : undefined;

    // Resolve source transcript
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: sourceAgentId,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    // Create branched session file
    try {
      const manager = SessionManager.open(transcriptPath);
      const forkFromId = entryId ?? manager.getLeafId();
      if (!forkFromId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "empty session"));
        return;
      }

      // Validate that the entry actually exists in the transcript
      if (manager.getEntry(forkFromId) === null) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `entry ${forkFromId} not found`),
        );
        return;
      }

      const newFile = manager.createBranchedSession(forkFromId);
      if (!newFile) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "fork failed"));
        return;
      }

      // Get the new session ID from the manager (already updated by createBranchedSession).
      // Avoid fs.readFileSync here because createBranchedSession may not have written the
      // file yet when the branch contains no assistant messages (write is deferred).
      const newSessionId = manager.getSessionId() ?? randomUUID();

      // Force-write the file now so that history loading works immediately after fork,
      // even for sessions that only contain user messages.
      if (!fs.existsSync(newFile)) {
        (manager as unknown as { _rewriteFile(): void })._rewriteFile();
      }

      // Create a new session store entry
      const newKey = buildDashboardSessionKey(targetAgentId);
      const target = resolveGatewaySessionStoreTarget({ cfg, key: newKey });
      await updateSessionStore(target.storePath, async (store) => {
        const sessionEntry: SessionEntry = {
          sessionId: newSessionId,
          updatedAt: Date.now(),
          sessionFile: path.basename(newFile),
          parentSessionKey: sourceCanonicalKey,
          forkedFromParent: true,
        };
        if (typeof p.label === "string" && p.label.trim()) {
          sessionEntry.label = p.label.trim();
        }
        store[target.canonicalKey] = sessionEntry;
      });

      respond(true, {
        ok: true,
        key: target.canonicalKey,
        sessionId: newSessionId,
        parentSessionKey: sourceCanonicalKey,
      });
      emitSessionsChanged(context, { sessionKey: target.canonicalKey, reason: "create" });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Edit ───
  "sessions.messages.edit": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesEditParams,
        "sessions.messages.edit",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const sessionKey = p.key.trim();
    const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: agentId ?? undefined,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    try {
      const manager = SessionManager.open(transcriptPath);
      const targetEntry = manager.getEntry(p.entryId);
      if (!targetEntry || targetEntry.type !== "message") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "entry not found"));
        return;
      }

      const msgEntry = targetEntry;
      const parentId = targetEntry.parentId;
      if (!parentId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "cannot edit root entry"));
        return;
      }

      // Capture entries that follow the edited message on the active branch so they
      // can be re-appended after the edit, preserving subsequent messages.
      const { branchEntries: preBranchEntries, targetIdx } = resolveBranchContainingEntry(
        manager,
        p.entryId,
      );
      const tailEntries = targetIdx >= 0 ? preBranchEntries.slice(targetIdx + 1) : [];

      // Branch from the parent of the target entry
      manager.branch(parentId);

      // Append new message with edited content, preserving the original role and metadata
      const originalMsg = msgEntry.message as unknown as Record<string, unknown>;
      const newContent = p.content;
      const editedMessage = {
        ...originalMsg,
        content: [{ type: "text", text: newContent }],
        timestamp: Date.now(),
      };

      const newEntryId = manager.appendMessage(
        editedMessage as Parameters<SessionManager["appendMessage"]>[0],
      );

      reappendTailEntries(manager, tailEntries);

      // Use the current leaf after all re-appends as the new active leaf
      const newLeafId = manager.getLeafId() ?? newEntryId;
      await updateSessionStore(
        resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key: canonicalKey }).storePath,
        (store) => {
          if (store[canonicalKey]) {
            store[canonicalKey] = {
              ...store[canonicalKey],
              activeLeafId: newLeafId,
              updatedAt: Date.now(),
            };
          }
        },
      );

      // Emit transcript update
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: canonicalKey,
        message: editedMessage,
        messageId: newEntryId,
      });

      // Read updated branch messages
      const messages = readSessionBranchMessages(transcriptPath, newLeafId);

      respond(true, {
        ok: true,
        entryId: newEntryId,
        activeLeafId: newLeafId,
        messages,
      });
      emitSessionsChanged(context, { sessionKey: canonicalKey, reason: "edit" });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Delete ───
  "sessions.messages.delete": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesDeleteParams,
        "sessions.messages.delete",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const sessionKey = p.key.trim();
    const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: agentId ?? undefined,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    try {
      const manager = SessionManager.open(transcriptPath);
      const targetEntry = manager.getEntry(p.entryId);
      if (!targetEntry || targetEntry.type !== "message") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "entry not found"));
        return;
      }

      const msgEntry = targetEntry;
      const msgRole = (msgEntry.message as unknown as Record<string, unknown>).role as
        | string
        | undefined;

      // Helper: returns true when a message consists entirely of tool_result content blocks,
      // meaning it is an automated tool-result relay rather than a human-authored message.
      const isToolResultMessage = (msg: Record<string, unknown>): boolean => {
        const content = msg.content;
        if (!Array.isArray(content) || content.length === 0) {
          return false;
        }
        return content.every(
          (blk) =>
            typeof blk === "object" &&
            blk !== null &&
            (blk as Record<string, unknown>).type === "tool_result",
        );
      };

      // Walk the active branch to determine the full "turn" to remove.
      const { branchEntries, targetIdx } = resolveBranchContainingEntry(manager, p.entryId);
      if (targetIdx < 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "entry not found in active branch"),
        );
        return;
      }

      let turnStartIdx = targetIdx;
      let turnEndIdx = targetIdx;

      if (msgRole === "user") {
        // Scan forward to find the last assistant message in the turn,
        // skipping over tool-result user messages and intermediate assistant messages.
        for (let i = targetIdx + 1; i < branchEntries.length; i++) {
          const e = branchEntries[i];
          if (e.type !== "message") {
            continue;
          }
          const role =
            ((e.message as unknown as Record<string, unknown>).role as string | undefined) ?? "";
          if (role === "assistant") {
            turnEndIdx = i; // extend the turn end to include this assistant
          } else if (
            role === "user" &&
            !isToolResultMessage(e.message as unknown as Record<string, unknown>)
          ) {
            break; // next human message starts here – stop
          }
          // tool_result user messages: continue scanning (they belong to the current turn)
        }
      } else if (msgRole === "assistant") {
        // Scan backward to find the human user message that started this turn,
        // skipping over tool-result user messages and intermediate assistant messages.
        for (let i = targetIdx - 1; i >= 0; i--) {
          const e = branchEntries[i];
          if (e.type !== "message") {
            continue;
          }
          const role =
            ((e.message as unknown as Record<string, unknown>).role as string | undefined) ?? "";
          if (
            role === "user" &&
            !isToolResultMessage(e.message as unknown as Record<string, unknown>)
          ) {
            turnStartIdx = i; // found the human message that opened this turn
            break;
          }
          turnStartIdx = i; // tool-result user or intermediate assistant – extend backwards
        }

        // Count assistant messages in this turn to decide deletion scope.
        // When the turn contains multiple assistant responses, only remove
        // the targeted one (plus its trailing tool-result relay messages);
        // otherwise fall through and delete the entire turn.
        let assistantCount = 0;
        for (let i = turnStartIdx; i < branchEntries.length; i++) {
          const e = branchEntries[i];
          if (e.type !== "message") {
            continue;
          }
          const role =
            ((e.message as unknown as Record<string, unknown>).role as string | undefined) ?? "";
          if (
            i > turnStartIdx &&
            role === "user" &&
            !isToolResultMessage(e.message as unknown as Record<string, unknown>)
          ) {
            break; // next human turn
          }
          if (role === "assistant") {
            assistantCount++;
          }
        }

        if (assistantCount > 1) {
          // Only delete this single assistant response and any immediately
          // following tool-result user messages (they relay results for this
          // assistant's tool calls and are meaningless without it).
          turnStartIdx = targetIdx;
          turnEndIdx = targetIdx;
          for (let i = targetIdx + 1; i < branchEntries.length; i++) {
            const e = branchEntries[i];
            if (e.type !== "message") {
              continue;
            }
            const role =
              ((e.message as unknown as Record<string, unknown>).role as string | undefined) ?? "";
            if (
              role === "user" &&
              isToolResultMessage(e.message as unknown as Record<string, unknown>)
            ) {
              turnEndIdx = i; // tool-result belongs to this assistant's tool calls
            } else {
              break; // next assistant or real user message
            }
          }
        }
      }

      // The branch point is the last entry BEFORE the turn (what to keep).
      const branchEntry = turnStartIdx > 0 ? branchEntries[turnStartIdx - 1] : null;
      const branchToId = branchEntry?.id ?? null;

      // Tail entries after the turn end, to re-stitch for subsequent turns.
      const tailEntries = branchEntries.slice(turnEndIdx + 1);

      if (!branchToId) {
        manager.resetLeaf();
      } else {
        manager.branch(branchToId);
      }

      reappendTailEntries(manager, tailEntries);

      // If no tail entries were appended we still need a write to persist the branch
      // in the append-only transcript file.
      if (tailEntries.length === 0) {
        manager.appendCustomEntry("openclaw:branch-delete", {
          deletedEntryId: p.entryId,
          timestamp: Date.now(),
        });
      }

      // Clear per-session bootstrap cache so the agent sees the updated history.
      clearBootstrapSnapshot(canonicalKey);

      const newLeafId = manager.getLeafId() ?? null;
      await updateSessionStore(
        resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key: canonicalKey }).storePath,
        (store) => {
          if (store[canonicalKey]) {
            store[canonicalKey] = {
              ...store[canonicalKey],
              activeLeafId: newLeafId ?? undefined,
              updatedAt: Date.now(),
            };
          }
        },
      );

      const messages = newLeafId ? readSessionBranchMessages(transcriptPath, newLeafId) : [];

      respond(true, { ok: true, activeLeafId: newLeafId, messages });
      emitSessionsChanged(context, { sessionKey: canonicalKey, reason: "delete" });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Versions ───
  "sessions.messages.versions": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesVersionsParams,
        "sessions.messages.versions",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const sessionKey = p.key.trim();
    const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: agentId ?? undefined,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    try {
      const manager = SessionManager.open(transcriptPath);
      const targetEntry = manager.getEntry(p.entryId);
      if (!targetEntry) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "entry not found"));
        return;
      }

      // Get the parent of this entry – its siblings are the "versions"
      const parentId = targetEntry.parentId;
      if (!parentId) {
        respond(true, { versions: [], activeIndex: 0 });
        return;
      }

      const versions = getEntryVersions(transcriptPath, parentId, entry.activeLeafId);
      const activeIndex = versions.findIndex((v) => v.isActive);

      respond(true, {
        versions: versions.map((v, i) => ({
          entryId: v.entryId,
          index: i,
          isActive: v.isActive,
        })),
        activeIndex: activeIndex >= 0 ? activeIndex : 0,
        total: versions.length,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Switch Version ───
  "sessions.messages.switch-version": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSwitchVersionParams,
        "sessions.messages.switch-version",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const sessionKey = p.key.trim();
    const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: agentId ?? undefined,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    try {
      // Find the tip of the branch starting from the target entry
      const newLeafId = findBranchTip(transcriptPath, p.entryId);
      if (!newLeafId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "entry not found"));
        return;
      }

      await updateSessionStore(
        resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key: canonicalKey }).storePath,
        (store) => {
          if (store[canonicalKey]) {
            store[canonicalKey] = {
              ...store[canonicalKey],
              activeLeafId: newLeafId,
              updatedAt: Date.now(),
            };
          }
        },
      );

      const messages = readSessionBranchMessages(transcriptPath, newLeafId);

      respond(true, { ok: true, activeLeafId: newLeafId, messages });
      emitSessionsChanged(context, { sessionKey: canonicalKey, reason: "switch-version" });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Regenerate ───
  "chat.regenerate": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateChatRegenerateParams, "chat.regenerate", respond)) {
      return;
    }
    const p = params;
    const sessionKey = p.sessionKey.trim();
    const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: agentId ?? undefined,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    try {
      const manager = SessionManager.open(transcriptPath);
      // Use the natural (last-appended) leaf rather than the potentially stale
      // activeLeafId.  After a prior regeneration, activeLeafId points to the
      // branch-regenerate marker while the agent's async run appended the real
      // user + assistant entries beyond it.  The natural leaf picks those up,
      // matching the same logic chat.history uses (see its comment about stale
      // activeLeafId values).
      const effectiveLeaf = manager.getLeafId();
      if (!effectiveLeaf) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "empty session"));
        return;
      }

      // Walk the current branch to find the last user message
      const branch = manager.getBranch(effectiveLeaf);
      let lastUserEntryId: string | null = null;
      let lastUserMessage: string | null = null;
      for (const e of branch) {
        if (
          e.type === "message" &&
          (e.message as unknown as Record<string, unknown>).role === "user"
        ) {
          lastUserEntryId = e.id;
          const content = (e.message as unknown as Record<string, unknown>).content;
          if (typeof content === "string") {
            lastUserMessage = content;
          } else if (Array.isArray(content)) {
            const textBlock = content.find(
              (b: unknown) =>
                typeof b === "object" &&
                b !== null &&
                (b as Record<string, unknown>).type === "text",
            ) as Record<string, unknown> | undefined;
            lastUserMessage = typeof textBlock?.text === "string" ? textBlock.text : "";
          }
        }
      }

      if (!lastUserEntryId || lastUserMessage === null) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no user message found"));
        return;
      }

      // Branch to the entry BEFORE the last user message so that chat.send can write
      // a fresh user turn without duplicating it in the LLM context.  The previous
      // approach (branching AT the user entry) left the old user+assistant turn in the
      // file, causing the agent to see the same message twice in a row.
      const lastUserEntry = manager.getEntry(lastUserEntryId);
      const branchToId = lastUserEntry?.parentId ?? null;
      if (branchToId) {
        manager.branch(branchToId);
      } else {
        // First message in the session – reset so the next append becomes the new root.
        manager.resetLeaf();
      }
      // Persist the branch: branch() is in-memory only; appending a marker makes the
      // new leaf position durable so the agent runner reads the correct history.
      manager.appendCustomEntry("openclaw:branch-regenerate", {
        regeneratedFromEntryId: lastUserEntryId,
        timestamp: Date.now(),
      });
      const newLeafId = manager.getLeafId();

      // Update active leaf (will be updated again after the agent responds)
      await updateSessionStore(
        resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key: canonicalKey }).storePath,
        (store) => {
          if (store[canonicalKey]) {
            store[canonicalKey] = {
              ...store[canonicalKey],
              activeLeafId: newLeafId ?? undefined,
              updatedAt: Date.now(),
            };
          }
        },
      );

      // Re-send the last user message via chat.send to trigger a new response
      const idempotencyKey = p.idempotencyKey;
      let sendResponse: { ok: boolean; payload?: unknown; error?: unknown } = { ok: false };
      await chatHandlers["chat.send"]({
        req,
        params: {
          sessionKey: canonicalKey,
          message: lastUserMessage,
          idempotencyKey,
        },
        respond: (ok, payload, error) => {
          sendResponse = { ok, payload, error };
        },
        context,
        client,
        isWebchatConnect,
      });

      if (sendResponse.ok) {
        respond(true, {
          ok: true,
          regenerated: true,
          ...(sendResponse.payload && typeof sendResponse.payload === "object"
            ? sendResponse.payload
            : {}),
        });
      } else {
        respond(false, undefined, sendResponse.error as Parameters<RespondFn>[2]);
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Continue ───
  "chat.continue": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateChatContinueParams, "chat.continue", respond)) {
      return;
    }
    const p = params;
    const sessionKey = p.sessionKey.trim();
    const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown session"));
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(canonicalKey);
    const transcriptPath = resolveTranscriptForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: agentId ?? undefined,
    });
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "transcript not found"));
      return;
    }

    try {
      const manager = SessionManager.open(transcriptPath);

      // If a specific entry is given, branch from it
      if (typeof p.entryId === "string" && p.entryId.trim()) {
        const targetEntry = manager.getEntry(p.entryId.trim());
        if (!targetEntry) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "entry not found"));
          return;
        }
        manager.branch(targetEntry.id);
        await updateSessionStore(
          resolveGatewaySessionStoreTarget({ cfg: loadConfig(), key: canonicalKey }).storePath,
          (store) => {
            if (store[canonicalKey]) {
              store[canonicalKey] = {
                ...store[canonicalKey],
                activeLeafId: targetEntry.id,
                updatedAt: Date.now(),
              };
            }
          },
        );
      }

      // Extract the assistant text to use as prefill.
      // For explicit prefill mode (handlePrefillSend), use the provided text.
      // For continue-from-entry mode (handleContinue with entryId), extract
      // text from the target assistant message so the LLM can continue it.
      let assistantPrefillText = "";
      const explicitPrefill = typeof p.prefill === "string" ? p.prefill.trim() : "";

      if (explicitPrefill) {
        // prefill mode: user provided text via handlePrefillSend
        assistantPrefillText = explicitPrefill;
      } else {
        // continue mode: extract text from the leaf (which should be the assistant entry)
        const leafEntry = manager.getLeafEntry();
        if (leafEntry?.type === "message") {
          const msg = leafEntry.message;
          if (msg.role === "assistant") {
            const textParts = (msg.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text!);
            if (textParts.length > 0) {
              assistantPrefillText = textParts.join("");
            }

            // Strip cumulative text prefix: walk the branch to find the prior
            // assistant message with tool calls and strip its text prefix from
            // the extracted prefill so the LLM sees only the continuation.
            if (assistantPrefillText) {
              const branch = manager.getBranch();
              const stripProcess = createCumulativeTextStripperLocal();
              let strippedLeafMsg: Record<string, unknown> | undefined;
              for (const entry of branch) {
                if (entry.type === "message") {
                  const processed = stripProcess(
                    entry.message as unknown as Record<string, unknown>,
                  );
                  if (entry.id === leafEntry.id) {
                    strippedLeafMsg = processed as Record<string, unknown>;
                  }
                }
              }
              if (strippedLeafMsg && Array.isArray(strippedLeafMsg.content)) {
                const strippedParts = (
                  strippedLeafMsg.content as Array<{ type: string; text?: string }>
                )
                  .filter((c) => c.type === "text" && typeof c.text === "string")
                  .map((c) => c.text!);
                if (strippedParts.length > 0) {
                  assistantPrefillText = strippedParts.join("");
                }
              }
            }
          }
        }
      }

      // Use a minimal placeholder message to drive the pipeline. It is not
      // persisted to the transcript — the attempt runner suppresses it — and
      // the streamFn wrapper replaces it with the assistant prefill before
      // calling the LLM.
      const continueMessage = "Continue";

      const idempotencyKey = p.idempotencyKey;

      // Store the assistant prefill so chat.send can thread it into replyOptions
      if (assistantPrefillText) {
        pendingAssistantPrefill.set(idempotencyKey, assistantPrefillText);
      }

      let sendResponse: { ok: boolean; payload?: unknown; error?: unknown } = { ok: false };
      await chatHandlers["chat.send"]({
        req,
        params: {
          sessionKey: canonicalKey,
          message: continueMessage,
          idempotencyKey,
        },
        respond: (ok, payload, error) => {
          sendResponse = { ok, payload, error };
        },
        context,
        client,
        isWebchatConnect,
      });

      if (sendResponse.ok) {
        respond(true, {
          ok: true,
          continued: true,
          ...(sendResponse.payload && typeof sendResponse.payload === "object"
            ? sendResponse.payload
            : {}),
        });
      } else {
        respond(false, undefined, sendResponse.error as Parameters<RespondFn>[2]);
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
