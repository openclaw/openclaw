import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import { captureSubagentCompletionReply } from "../subagent-announce.js";
import { getSubagentRunByChildSessionKey, setSuppressAutoAnnounce } from "../subagent-registry.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const MAX_AWAIT_SESSIONS = 20;
const DEFAULT_TIMEOUT_SECONDS = 300;

const SessionsAwaitToolSchema = Type.Object({
  sessionKeys: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_AWAIT_SESSIONS }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
});

type AwaitResult = {
  sessionKey: string;
  status: "completed" | "error" | "timeout" | "not_found";
  runId?: string;
  reply?: string;
  error?: string;
};

export function createSessionsAwaitTool(_opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_await",
    description:
      "Block until one or more spawned sub-agent sessions complete and return their combined results. Use after spawning multiple sub-agents in parallel to reliably collect all results before proceeding.",
    parameters: SessionsAwaitToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawKeys = params.sessionKeys;

      if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        return jsonResult({
          status: "error",
          error: "sessionKeys must be a non-empty array of session key strings",
        });
      }
      if (rawKeys.length > MAX_AWAIT_SESSIONS) {
        return jsonResult({
          status: "error",
          error: `sessionKeys exceeds maximum of ${MAX_AWAIT_SESSIONS}`,
        });
      }

      const sessionKeys = rawKeys
        .map((k) => (typeof k === "string" ? k.trim() : ""))
        .filter(Boolean);
      if (sessionKeys.length === 0) {
        return jsonResult({
          status: "error",
          error: "sessionKeys must contain at least one non-empty string",
        });
      }

      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(1, Math.floor(params.timeoutSeconds))
          : DEFAULT_TIMEOUT_SECONDS;
      const timeoutMs = timeoutSeconds * 1000;
      const deadline = Date.now() + timeoutMs;

      // Resolve each session key to a registry run entry.
      const lookups = sessionKeys.map((key) => ({
        sessionKey: key,
        run: getSubagentRunByChildSessionKey(key),
      }));

      // Suppress auto-announce before waiting so results are delivered only
      // via this tool return, avoiding duplicate messages in the parent context.
      const activeEntries = lookups.filter((e) => e.run && typeof e.run.endedAt !== "number");
      for (const e of activeEntries) {
        setSuppressAutoAnnounce(e.run!.runId);
      }

      if (activeEntries.length > 0) {
        const remainingMs = Math.max(1, deadline - Date.now());
        await Promise.allSettled(
          activeEntries.map((e) =>
            callGateway<{ status?: string }>({
              method: "agent.wait",
              params: { runId: e.run!.runId, timeoutMs: remainingMs },
              timeoutMs: remainingMs + 10_000,
            }).catch(() => undefined),
          ),
        );
      }

      // Re-read registry state after waiting and capture replies.
      const results: AwaitResult[] = await Promise.all(
        sessionKeys.map(async (sessionKey) => {
          const run = getSubagentRunByChildSessionKey(sessionKey);
          if (!run) {
            return {
              sessionKey,
              status: "not_found" as const,
              error: "No registered run found for this session key",
            };
          }

          if (typeof run.endedAt !== "number") {
            return {
              sessionKey,
              status: "timeout" as const,
              runId: run.runId,
              error: "Sub-agent did not complete within the timeout",
            };
          }

          const isError = run.outcome?.status === "error";
          const reply = await captureSubagentCompletionReply(sessionKey);
          const replyText = reply?.trim() || run.frozenResultText?.trim() || undefined;

          return {
            sessionKey,
            status: isError ? ("error" as const) : ("completed" as const),
            runId: run.runId,
            reply: replyText,
            ...(isError && run.outcome?.error ? { error: String(run.outcome.error) } : {}),
          };
        }),
      );

      const allSettled = results.every((r) => r.status === "completed" || r.status === "error");
      const anyTimeout = results.some((r) => r.status === "timeout");

      return jsonResult({
        status: allSettled ? "ok" : anyTimeout ? "partial" : "error",
        results,
      });
    },
  };
}
