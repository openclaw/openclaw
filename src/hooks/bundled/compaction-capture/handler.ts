/**
 * Compaction capture hook
 *
 * Preserves experiential state when context compaction occurs.
 * Compaction = context loss, so this is the most critical capture point.
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "../../../config/config.js";
import type { CompactionCheckpoint } from "../../../experiential/types.js";
import type { HookHandler } from "../../hooks.js";
import { ExperientialStore } from "../../../experiential/store.js";
import { resolveHookConfig } from "../../config.js";

const HOOK_KEY = "compaction-capture";

/**
 * Extract topic-like phrases from a summary string.
 * Simple heuristic: looks for capitalized phrases and key terms.
 */
function extractTopics(summary: string): string[] {
  const topics: string[] = [];
  const lines = summary.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    const trimmed = line.replace(/^[-*#]+\s*/, "").trim();
    // Lines that look like topic headers or bullet points with substance
    if (trimmed.length > 3 && trimmed.length < 120) {
      topics.push(trimmed);
    }
  }
  // Keep at most 10 topics
  return topics.slice(0, 10);
}

/**
 * Extract phrases that serve as conversation anchors (commitments, decisions, etc.)
 */
function extractAnchors(summary: string): string[] {
  const anchors: string[] = [];
  const anchorPatterns = [
    /(?:decided|agreed|committed|planned|will)\s+.{10,80}/gi,
    /(?:key|important|critical|note):\s*.{10,80}/gi,
  ];

  for (const pattern of anchorPatterns) {
    const matches = summary.match(pattern) || [];
    anchors.push(...matches.map((m) => m.trim()));
  }

  return anchors.slice(0, 5);
}

const compactionCaptureHook: HookHandler = async (event) => {
  if (event.type !== "session" || event.action !== "compaction_summary") {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const hookConfig = resolveHookConfig(cfg, HOOK_KEY);

    // Enabled by default; skip only if explicitly disabled
    if (hookConfig?.enabled === false) {
      return;
    }

    const summary = context.summary as string | undefined;
    if (!summary || typeof summary !== "string") {
      console.log("[compaction-capture] No summary in event context, skipping");
      return;
    }

    const checkpoint: CompactionCheckpoint = {
      id: crypto.randomUUID(),
      version: 1,
      timestamp: event.timestamp.getTime(),
      sessionKey: event.sessionKey,
      trigger: "compaction",
      activeTopics: extractTopics(summary),
      keyContextSummary: summary,
      openUncertainties: [],
      conversationAnchors: extractAnchors(summary),
    };

    const store = new ExperientialStore();
    try {
      store.saveCheckpoint(checkpoint);
      console.log(`[compaction-capture] Checkpoint saved: ${checkpoint.id}`);
    } finally {
      store.close();
    }
  } catch (err) {
    console.error(
      "[compaction-capture] Failed to save checkpoint:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default compactionCaptureHook;
