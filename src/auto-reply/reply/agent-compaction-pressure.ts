import { estimateTokens } from "@mariozechner/pi-coding-agent";
/**
 * Agent-controlled compaction: check context pressure and inject a system event
 * signal instead of running a memory flush turn.
 *
 * Extracted to its own module to avoid circular import chains from
 * agent-runner-memory.ts's heavy transitive dependency graph.
 */
import {
  computeContextPressure,
  formatContextPressureMessage,
} from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

/**
 * Estimate current context tokens from the session transcript.
 * Uses chars/4 heuristic (same as upstream compaction).
 * Reads only kept messages (respects compaction markers).
 */
function estimateSessionTokensFromTranscript(entry: SessionEntry): number | undefined {
  const sessionId = (entry as Record<string, unknown>).sessionId as string | undefined;
  if (!sessionId) {
    return undefined;
  }
  try {
    const fs = require("node:fs");
    const { resolveSessionTranscriptCandidates } = require("../../gateway/session-utils.fs.js");
    const candidates = resolveSessionTranscriptCandidates(
      sessionId,
      undefined,
      (entry as Record<string, unknown>).sessionFile as string | undefined,
    );
    const filePath = candidates.find((p: string) => fs.existsSync(p));
    if (!filePath) {
      return undefined;
    }

    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);

    // Find last compaction's firstKeptEntryId
    let firstKeptId: string | null = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (parsed?.type === "compaction" && parsed.firstKeptEntryId) {
          firstKeptId = parsed.firstKeptEntryId as string;
        }
      } catch {
        // ignore malformed lines
      }
    }

    // Collect only kept messages (after compaction marker)
    let foundKept = !firstKeptId; // if no compaction, keep all
    const messages: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (!foundKept && parsed?.id === firstKeptId) {
          foundKept = true;
        }
        // Include compaction summary as a message
        if (parsed?.type === "compaction" && parsed.summary) {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: parsed.summary }],
            timestamp: Date.now(),
          });
        }
        if (foundKept && parsed?.message) {
          messages.push(parsed.message);
        }
      } catch {
        // ignore malformed lines
      }
    }

    if (messages.length === 0) {
      return undefined;
    }
    let total = 0;
    for (const msg of messages) {
      total += estimateTokens(msg as Parameters<typeof estimateTokens>[0]);
    }
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

export function maybeInjectAgentCompactionPressureSignal(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): SessionEntry | undefined {
  const entry = params.sessionEntry;
  if (!entry) {
    return entry;
  }

  // Prefer explicit agent config contextTokens over catalog-reported value
  // (GH Copilot reports 1M for Claude Opus but real limit is 200k)
  const contextWindowTokens =
    params.agentCfgContextTokens ??
    ((entry as Record<string, unknown>).contextTokens as number | undefined) ??
    128_000;

  const totalTokens = estimateSessionTokensFromTranscript(entry);

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${totalTokens} contextWindow=${contextWindowTokens} ` +
      `threshold=${contextWindowTokens * 0.85} ` +
      `estimated=true method=transcript`,
  );

  const signal = computeContextPressure({
    totalTokens: totalTokens ?? undefined,
    contextWindowTokens,
  });

  if (signal && params.sessionKey) {
    const message = formatContextPressureMessage(signal);
    void import("../../infra/system-events.js").then(({ enqueueSystemEvent }) => {
      enqueueSystemEvent(message, { sessionKey: params.sessionKey! });
    });
    logVerbose(
      `agent-compaction pressure signal: sessionKey=${params.sessionKey} ` +
        `pressure=${signal.pressure} recommended=${signal.compactionRecommended}`,
    );
  }

  return entry;
}
