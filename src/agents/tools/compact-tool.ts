import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveUserTimezone } from "../date-time.js";
import type { AnyAgentTool } from "./common.js";

const log = createSubsystemLogger("agent-compaction");

// Dynamic import of SDK compaction internals (no type declarations available).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prepareCompaction: ((pathEntries: any[], settings: any) => any) | undefined;

async function loadPrepareCompaction(): Promise<void> {
  try {
    // SDK internal - not in package.json exports map. Use import.meta to find
    // our own dist dir, walk up to node_modules. Convert to file:// URL to bypass exports.
    const { resolve, dirname } = await import("node:path");
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const { existsSync } = await import("node:fs");
    // Walk up from the bundled file until we find a directory containing node_modules/,
    // since the bundled output may be nested (e.g. dist/plugin-sdk/).
    const target = "@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js";
    let dir = dirname(fileURLToPath(import.meta.url));
    let abs = "";
    for (let i = 0; i < 10; i++) {
      const candidate = resolve(dir, "node_modules", target);
      if (existsSync(candidate)) {
        abs = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (!abs) {
      throw new Error(`Could not find ${target} in any ancestor node_modules`);
    }
    const mod = await import(pathToFileURL(abs).href);
    prepareCompaction = mod.prepareCompaction as typeof prepareCompaction;
  } catch (err) {
    log.warn(`Failed to load SDK prepareCompaction: ${String(err)}`);
  }
}
// Eager init
const _initPromise = loadPrepareCompaction();

const CompactToolSchema = Type.Object({
  summary: Type.String({
    description:
      "Your summary of the conversation so far. Include: current goals, progress, key decisions, " +
      "open questions, and any context needed to continue seamlessly. This replaces older history.",
  }),
});

function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (y && m && d) {
    return `${y}-${m}-${d}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function createCompactTool(options: {
  sessionKey?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  getSessionManager?: () => import("@mariozechner/pi-coding-agent").SessionManager | undefined;
}): AnyAgentTool | null {
  const cfg = options.config;
  const mode = cfg?.agents?.defaults?.compaction?.mode;
  if (mode !== "agent") {
    return null;
  }

  // prepareCompaction loads async — if not ready at tool creation, that's OK.
  // execute() awaits _initPromise before using it.

  return {
    name: "compact",
    description:
      "Compact conversation history by replacing older messages with your summary. " +
      "Call this when you receive a context pressure signal recommending compaction.",
    label: "Compact conversation history",
    parameters: CompactToolSchema,
    async execute(_toolCallId, params) {
      await _initPromise;
      if (!prepareCompaction) {
        return {
          content: [{ type: "text", text: "Error: compaction module not available." }],
          details: undefined,
        };
      }
      const _prep = prepareCompaction;
      const summary = (params as { summary?: string }).summary?.trim();
      if (!summary) {
        return {
          content: [{ type: "text", text: "Error: summary is required and cannot be empty." }],
          details: undefined,
        };
      }

      const sessionKey = options.sessionKey;
      if (!sessionKey) {
        return {
          content: [{ type: "text", text: "Error: no session key available." }],
          details: undefined,
        };
      }

      try {
        // Resolve session file from session store (sessionKey → entry.sessionFile → path)
        const agentId = resolveAgentIdFromSessionKey(sessionKey);
        const storePath = resolveStorePath(undefined, { agentId });
        const store = loadSessionStore(storePath);
        const entry = store?.[sessionKey];
        const filePathOpts = resolveSessionFilePathOptions({ agentId, storePath });
        const sessionFile = resolveSessionFilePath(
          sessionKey,
          entry?.sessionFile ? { sessionFile: entry.sessionFile } : undefined,
          filePathOpts,
        );
        if (!fs.existsSync(sessionFile)) {
          return {
            content: [{ type: "text", text: "Error: session file not found." }],
            details: undefined,
          };
        }

        const sessionManager = options.getSessionManager?.() ?? SessionManager.open(sessionFile);
        const pathEntries = sessionManager.getBranch();

        const settings = {
          reserveTokens: cfg?.agents?.defaults?.compaction?.reserveTokens ?? 0,
          keepRecentTokens: cfg?.agents?.defaults?.compaction?.keepRecentTokens ?? 4096,
        };

        const preparation = _prep(pathEntries, settings);
        if (!preparation) {
          return {
            content: [
              {
                type: "text",
                text: "Nothing to compact (session too small or already compacted).",
              },
            ],
            details: undefined,
          };
        }

        const { firstKeptEntryId, tokensBefore } = preparation;

        sessionManager.appendCompaction(
          summary,
          firstKeptEntryId,
          tokensBefore,
          undefined, // details
          true, // fromHook
        );

        log.info(
          `Agent compaction: sessionKey=${sessionKey} tokensBefore=${tokensBefore} summaryLength=${summary.length}`,
        );

        // Update session store compaction counter
        await incrementCompactionCount({
          sessionEntry: entry,
          sessionStore: store,
          sessionKey,
          storePath,
        });

        // Append to daily memory file
        const nowMs = Date.now();
        const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
        const dateStamp = formatDateStamp(nowMs, timezone);
        const workspaceDir = options.workspaceDir;

        if (workspaceDir) {
          const memoryDir = path.join(workspaceDir, "memory");
          const dailyFile = path.join(memoryDir, `${dateStamp}.md`);
          const journalEntry = `\n${summary}\n`;
          try {
            if (!fs.existsSync(memoryDir)) {
              fs.mkdirSync(memoryDir, { recursive: true });
            }
            fs.appendFileSync(dailyFile, journalEntry, "utf-8");
          } catch (fsErr) {
            log.warn(`Failed to append compaction summary to ${dailyFile}: ${String(fsErr)}`);
          }
        } else {
          log.debug("Skipping daily journal append — no workspaceDir configured");
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Compaction complete. tokensBefore=${tokensBefore}, summaryLength=${summary.length}. ` +
                `Summary saved to session and memory/${dateStamp}.md. ` +
                `Next turn will load fresh context.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Agent compaction failed: sessionKey=${sessionKey} error=${msg}`);
        return {
          content: [{ type: "text", text: `Compaction failed: ${msg}` }],
          details: undefined,
        };
      }
    },
  };
}
