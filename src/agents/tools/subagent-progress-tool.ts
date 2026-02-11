/**
 * subagent_progress tool — allows sub-agents to report progress back to the
 * parent session during long-running tasks.
 *
 * When called, it looks up the parent session from the subagent registry and
 * injects a system event into that session. The parent agent then decides
 * whether to relay the update to the user.
 *
 * Only functional in sub-agent sessions (returns error otherwise).
 * 
 * Rate limiting: By default, progress updates are throttled to max 1 per 30 seconds
 * per session. If called too soon, returns success without sending to parent.
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { callGateway } from "../../gateway/call.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { findSubagentRunByChildKey } from "../subagent-registry.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// Rate limiting: Track last-sent timestamps per session key
const lastProgressTimestamps = new Map<string, number>();
const FALLBACK_THROTTLE_MS = 30000; // 30 seconds fallback when no config is set

const SubagentProgressToolSchema = Type.Object({
  message: Type.String({
    description:
      "Progress update message. Keep concise — e.g. 'Built 6/12 workers', 'Research complete, starting analysis'.",
  }),
  percent: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: "Optional completion percentage (0-100).",
    }),
  ),
});

export function createSubagentProgressTool(opts?: {
  /** The current session key (used to verify this is a sub-agent session). */
  agentSessionKey?: string;
  /** Rate limiting throttle in milliseconds (default: 30000ms = 30s). */
  throttleMs?: number;
}): AnyAgentTool {
  return {
    label: "Sub-agent",
    name: "subagent_progress",
    description:
      "Report progress back to the parent agent during long-running tasks. " +
      "Use at major milestones (not every step) to keep the parent informed. " +
      "The parent decides whether to relay updates to the user.",
    parameters: SubagentProgressToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
      const percent =
        typeof params.percent === "number" && Number.isFinite(params.percent)
          ? Math.min(100, Math.max(0, Math.round(params.percent)))
          : undefined;

      const sessionKey = opts?.agentSessionKey;
      if (!sessionKey || !isSubagentSessionKey(sessionKey)) {
        return jsonResult({
          status: "error",
          error: "subagent_progress is only available in sub-agent sessions.",
        });
      }

      // Rate limiting: Check if enough time has passed since last update
      const cfg = loadConfig();
      const throttleMs = opts?.throttleMs ?? cfg.tools?.subagentProgress?.throttleMs ?? FALLBACK_THROTTLE_MS;
      const now = Date.now();
      const lastSent = lastProgressTimestamps.get(sessionKey);
      
      if (lastSent && (now - lastSent) < throttleMs) {
        // Called too soon - return success without sending to parent
        const progressText = percent !== undefined ? `[${percent}%] ${message}` : message;
        return jsonResult({
          status: "throttled",
          message: progressText,
          note: "Progress update throttled to prevent flooding parent session.",
        });
      }

      // Look up the parent from the subagent registry
      const runRecord = findSubagentRunByChildKey(sessionKey);
      const parentKey = runRecord?.requesterSessionKey;

      // If registry lookup fails, targetKey fallback uses resolveMainSessionKey

      const targetKey =
        parentKey ??
        (() => {
          // Derive parent key using configured mainKey (not hardcoded "main")
          const cfg = loadConfig();
          return resolveMainSessionKey(cfg);
        })();

      if (!targetKey) {
        return jsonResult({
          status: "error",
          error: "Could not determine parent session.",
        });
      }

      const progressText = percent !== undefined ? `[${percent}%] ${message}` : message;
      const label = runRecord?.label || "sub-agent task";

      const eventMessage = [
        `[Sub-agent Progress] "${label}"`,
        progressText,
        "",
        "This is an automated progress update from a running sub-agent.",
        "Briefly update the user if they're waiting, otherwise NO_REPLY.",
      ].join("\n");

      try {
        await callGateway({
          method: "agent",
          params: {
            sessionKey: targetKey,
            message: eventMessage,
            deliver: true,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });

        // Update the timestamp after successful send
        lastProgressTimestamps.set(sessionKey, now);

        return jsonResult({
          status: "sent",
          parentSessionKey: targetKey,
          message: progressText,
        });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          error: `Failed to report progress: ${errorText}`,
        });
      }
    },
  };
}
