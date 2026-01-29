import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compactEmbeddedPiSession,
  compactEmbeddedPiSessionDirect,
  isEmbeddedPiRunActive,
} from "../../agents/pi-embedded.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveStorePath,
} from "../../config/sessions.js";
import { resolveAgentIdFromSessionKey, DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { formatContextUsageShort, formatTokenCount } from "../../auto-reply/status.js";
import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import type { AnyAgentTool } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";

const SessionCompactToolSchema = Type.Object({
  instructions: Type.Optional(
    Type.String({
      description:
        "Optional instructions for what to focus on during compaction (e.g., 'Focus on decisions and open tasks')",
    }),
  ),
  threshold: Type.Optional(
    Type.Number({
      description:
        "Only compact if context usage exceeds this percentage (default: 0, meaning always compact). Set to 60 to skip compaction when context is below 60%.",
      minimum: 0,
      maximum: 100,
    }),
  ),
});

interface SessionCompactToolOpts {
  config?: ReturnType<typeof loadConfig>;
  agentSessionKey?: string;
  workspaceDir?: string;
  thinkLevel?: string;
}

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

function writeCompactionFile(params: {
  workspaceDir: string;
  tokensBefore?: number;
  tokensAfter?: number;
  contextBefore?: number;
  contextAfter?: number;
  instructions?: string;
}): string | null {
  try {
    const compactionsDir = path.join(params.workspaceDir, "memory", "compactions");
    if (!fs.existsSync(compactionsDir)) {
      fs.mkdirSync(compactionsDir, { recursive: true });
    }

    const timestamp = formatTimestamp();
    const filename = `${timestamp}.md`;
    const filepath = path.join(compactionsDir, filename);

    const content = `# Context Compaction - ${new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "full",
      timeStyle: "short",
    })}

## Compaction Summary
- **Tokens before:** ${params.tokensBefore ? formatTokenCount(params.tokensBefore) : "unknown"}
- **Tokens after:** ${params.tokensAfter ? formatTokenCount(params.tokensAfter) : "unknown"}
- **Context before:** ${params.contextBefore ? `${params.contextBefore}%` : "unknown"}
- **Context after:** ${params.contextAfter ? `${params.contextAfter}%` : "unknown"}
${params.instructions ? `- **Focus:** ${params.instructions}` : ""}

## Instructions
Read this file after compaction to restore context. Add your working state below.

## Active Task
<!-- What were you working on? -->

## Key Decisions
<!-- Important decisions made this session -->

## Next Steps
<!-- What needs to happen next? -->
`;

    fs.writeFileSync(filepath, content, "utf-8");
    return filepath;
  } catch {
    return null;
  }
}

export function createSessionCompactTool(opts?: SessionCompactToolOpts): AnyAgentTool {
  return {
    label: "Session Compact",
    name: "session_compact",
    description:
      "Compact the current session's context to free up token space. Use when context is above 60% to proactively manage memory. The compaction summarizes older conversation history while preserving recent messages. Automatically saves a compaction file to memory/compactions/ and returns the path.",
    parameters: SessionCompactToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as { instructions?: string; threshold?: number };
      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);

      const sessionKey = opts?.agentSessionKey;
      if (!sessionKey) {
        throw new Error("sessionKey required for compaction");
      }

      const agentId = resolveAgentIdFromSessionKey(sessionKey) || DEFAULT_AGENT_ID;
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);

      // Resolve the session entry
      const internalKey = resolveInternalSessionKey({
        key: sessionKey,
        alias,
        mainKey,
      });
      const entry = store[sessionKey] ?? store[internalKey];

      if (!entry?.sessionId) {
        return {
          content: [{ type: "text", text: "⚙️ Compaction unavailable (missing session id)." }],
          details: { ok: false, reason: "no sessionId" },
        };
      }

      // Check threshold - skip if context is below threshold
      const threshold = params.threshold ?? 0;
      const contextTokens = entry.contextTokens ?? 200_000; // Default to 200k if unknown
      const totalTokens = entry.totalTokens ?? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
      const currentContextPercent =
        contextTokens > 0 ? Math.round((totalTokens / contextTokens) * 100) : 0;

      if (threshold > 0 && currentContextPercent < threshold) {
        return {
          content: [
            {
              type: "text",
              text: `⏭️ Compaction skipped: context at ${currentContextPercent}% is below ${threshold}% threshold.`,
            },
          ],
          details: {
            ok: true,
            compacted: false,
            skipped: true,
            reason: `context ${currentContextPercent}% < threshold ${threshold}%`,
            currentContextPercent,
          },
        };
      }

      const sessionId = entry.sessionId;

      // If called from within an active run, use direct compaction to avoid
      // aborting ourselves (which would prevent the tool result from being saved).
      // Otherwise, use queued compaction for external callers.
      const runIsActive = isEmbeddedPiRunActive(sessionId);

      const configured = resolveDefaultModelForAgent({ cfg, agentId });
      const workspaceDir = opts?.workspaceDir ?? resolveAgentDir(cfg, agentId);

      const compactFn = runIsActive ? compactEmbeddedPiSessionDirect : compactEmbeddedPiSession;
      const result = await compactFn({
        sessionId,
        sessionKey,
        messageChannel: entry.lastChannel ?? entry.channel ?? "unknown",
        groupId: entry.groupId,
        groupChannel: entry.groupChannel,
        groupSpace: entry.space,
        spawnedBy: entry.spawnedBy,
        sessionFile: resolveSessionFilePath(sessionId, entry),
        workspaceDir,
        config: cfg,
        skillsSnapshot: entry.skillsSnapshot,
        provider: entry.providerOverride ?? configured.provider,
        model: entry.modelOverride ?? configured.model,
        thinkLevel: (opts?.thinkLevel ?? cfg.agents?.defaults?.thinkingDefault ?? "medium") as any,
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        customInstructions: params.instructions,
      });

      const compactLabel = result.ok
        ? result.compacted
          ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
            ? `Compacted (${formatTokenCount(result.result.tokensBefore)} → ${formatTokenCount(result.result.tokensAfter)})`
            : result.result?.tokensBefore
              ? `Compacted (${formatTokenCount(result.result.tokensBefore)} before)`
              : "Compacted"
          : "Compaction skipped"
        : "Compaction failed";

      if (result.ok && result.compacted) {
        await incrementCompactionCount({
          sessionEntry: entry,
          sessionStore: store,
          sessionKey,
          storePath,
          tokensAfter: result.result?.tokensAfter,
        });
      }

      // Calculate context percentages for the compaction file
      const tokensAfterCompaction = result.result?.tokensAfter;
      const contextAfterPercent =
        contextTokens > 0 && tokensAfterCompaction
          ? Math.round((tokensAfterCompaction / contextTokens) * 100)
          : undefined;

      // Auto-save compaction file
      let compactionFilePath: string | null = null;
      if (result.ok && result.compacted && workspaceDir) {
        compactionFilePath = writeCompactionFile({
          workspaceDir,
          tokensBefore: result.result?.tokensBefore,
          tokensAfter: result.result?.tokensAfter,
          contextBefore: currentContextPercent,
          contextAfter: contextAfterPercent,
          instructions: params.instructions,
        });
      }

      const newTotalTokens =
        tokensAfterCompaction ??
        entry.totalTokens ??
        (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
      const contextSummary = formatContextUsageShort(
        newTotalTokens > 0 ? newTotalTokens : null,
        entry.contextTokens ?? null,
      );

      const reason = result.reason?.trim();
      const statusLine = reason
        ? `${compactLabel}: ${reason} • ${contextSummary}`
        : `${compactLabel} • ${contextSummary}`;

      const fileNote = compactionFilePath
        ? `\n\n📁 Compaction file saved: \`${compactionFilePath}\`\nRead this file to restore your working context.`
        : "\n\nNext: Read your latest file from memory/compactions/ to restore context state.";

      return {
        content: [
          {
            type: "text",
            text: `🧹 ${statusLine}${fileNote}`,
          },
        ],
        details: {
          ok: result.ok,
          compacted: result.compacted,
          tokensBefore: result.result?.tokensBefore,
          tokensAfter: result.result?.tokensAfter,
          contextBefore: currentContextPercent,
          contextAfter: contextAfterPercent,
          compactionFile: compactionFilePath,
          reason: result.reason,
        },
      };
    },
  };
}
