import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { captureSubagentCompletionReply } from "../subagent-announce.js";
import {
  clearSuppressAutoAnnounce,
  getSubagentRunByChildSessionKey,
  setSuppressAutoAnnounce,
} from "../subagent-registry.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

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

function summarizeTransportError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  return "agent.wait transport error";
}

function resolveRunOwnerSessionKey(run: {
  controllerSessionKey?: string;
  requesterSessionKey: string;
}): string {
  const controllerSessionKey = run.controllerSessionKey?.trim();
  return controllerSessionKey || run.requesterSessionKey;
}

async function deleteAwaitedChildSession(params: {
  sessionKey: string;
  spawnMode?: "run" | "session";
}) {
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key: params.sessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: params.spawnMode === "session",
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

export function createSessionsAwaitTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
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
      const requesterSessionKeyRaw = opts?.agentSessionKey?.trim();
      if (!requesterSessionKeyRaw) {
        return jsonResult({
          status: "error",
          error: "sessions_await requires an active requester session context",
        });
      }
      const cfg = loadConfig();
      const { alias, mainKey } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = resolveInternalSessionKey({
        key: requesterSessionKeyRaw,
        alias,
        mainKey,
      });

      // Resolve each session key to a registry run entry.
      const lookups = sessionKeys.map((key) => {
        const run = getSubagentRunByChildSessionKey(key);
        if (!run) {
          return { sessionKey: key, run: null };
        }
        const ownerSessionKey = resolveRunOwnerSessionKey(run);
        if (ownerSessionKey !== requesterSessionKey) {
          // Treat cross-session keys as not_found to avoid leaking run existence.
          return { sessionKey: key, run: null };
        }
        return { sessionKey: key, run };
      });

      // Suppress auto-announce for all found runs before filtering by endedAt.
      // This narrows the race window where a run completes and fires announce
      // between the lookup snapshot and the suppression call.
      for (const e of lookups) {
        if (e.run) {
          setSuppressAutoAnnounce(e.run.runId);
        }
      }

      const activeEntries = lookups.filter((e) => e.run && typeof e.run.endedAt !== "number");

      // Wait for active runs and capture the gateway response status directly.
      const waitResults = new Map<string, { status?: string; error?: string }>();
      if (activeEntries.length > 0) {
        const remainingMs = Math.max(1, deadline - Date.now());
        await Promise.allSettled(
          activeEntries.map(async (e) => {
            try {
              const resp = await callGateway<{ status?: string; error?: string }>({
                method: "agent.wait",
                params: { runId: e.run!.runId, timeoutMs: remainingMs },
                timeoutMs: remainingMs + 10_000,
              });
              waitResults.set(
                e.run!.runId,
                resp ?? { status: "error", error: "agent.wait returned no result" },
              );
            } catch (err) {
              waitResults.set(e.run!.runId, {
                status: "error",
                error: summarizeTransportError(err),
              });
            }
          }),
        );
      }

      // Build results using wait response status (authoritative) with registry
      // fallback for already-completed runs.
      const results: AwaitResult[] = await Promise.all(
        lookups.map(async ({ sessionKey, run: initialRun }) => {
          if (!initialRun) {
            return {
              sessionKey,
              status: "not_found" as const,
              error: "No registered run found for this session key",
            };
          }
          const refreshedRun = getSubagentRunByChildSessionKey(sessionKey);
          if (refreshedRun && resolveRunOwnerSessionKey(refreshedRun) !== requesterSessionKey) {
            return {
              sessionKey,
              status: "not_found" as const,
              error: "No registered run found for this session key",
            };
          }
          // If cleanup evicts the run immediately after wait settles (cleanup=delete),
          // preserve the run we originally resolved so we can still return a deterministic result.
          const run = refreshedRun ?? initialRun;
          const runId = initialRun.runId;

          const waitResp = waitResults.get(runId);
          const waitStatus = waitResp?.status;
          const runTimedOut = run.outcome?.status === "timeout";
          const runEnded = typeof run.endedAt === "number";
          const cleanupDelete = run.cleanup === "delete";
          const isTimedOut =
            waitStatus === "timeout" ||
            runTimedOut ||
            (typeof run.endedAt !== "number" && typeof waitResp === "undefined");

          if (isTimedOut) {
            // Restore auto-announce so the child can still deliver if it completes later.
            clearSuppressAutoAnnounce(runId);
            if (cleanupDelete && runTimedOut) {
              await deleteAwaitedChildSession({
                sessionKey,
                spawnMode: run.spawnMode,
              });
            }
            return {
              sessionKey,
              status: "timeout" as const,
              runId,
              error: runTimedOut
                ? "Sub-agent timed out"
                : "Sub-agent did not complete within the timeout",
            };
          }

          const waitErrored =
            waitStatus === "error" ||
            (typeof waitResp !== "undefined" &&
              waitStatus !== "ok" &&
              waitStatus !== "timeout" &&
              waitStatus !== "error");
          if (waitErrored && typeof run.endedAt !== "number") {
            // Restore auto-announce so a later completion can still be delivered.
            clearSuppressAutoAnnounce(runId);
          }
          const isError = waitErrored || run.outcome?.status === "error";
          let replyText = run.frozenResultText?.trim() || undefined;
          let replyCaptureError: string | undefined;
          try {
            const reply = await captureSubagentCompletionReply(sessionKey);
            const capturedReply = reply?.trim();
            if (capturedReply) {
              replyText = capturedReply;
            }
          } catch (err) {
            replyCaptureError = `failed to capture sub-agent completion reply: ${summarizeTransportError(
              err,
            )}`;
          }
          const terminalForDelete =
            runTimedOut ||
            waitStatus === "ok" ||
            (waitStatus === "error" && runEnded) ||
            (typeof waitResp === "undefined" && runEnded);
          if (cleanupDelete && terminalForDelete && (!replyCaptureError || Boolean(replyText))) {
            await deleteAwaitedChildSession({
              sessionKey,
              spawnMode: run.spawnMode,
            });
          }
          const errorMessage = waitErrored
            ? waitResp?.error ||
              (waitStatus && waitStatus !== "error"
                ? `unexpected agent.wait status: ${waitStatus}`
                : "agent.wait failed")
            : run.outcome?.status === "error"
              ? String(run.outcome?.error || "subagent error")
              : replyCaptureError;

          return {
            sessionKey,
            status: isError ? ("error" as const) : ("completed" as const),
            runId,
            reply: replyText,
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        }),
      );

      const allCompleted = results.every((r) => r.status === "completed");
      const anyCompleted = results.some((r) => r.status === "completed");
      const anyTimeout = results.some((r) => r.status === "timeout");
      const status: "ok" | "partial" | "error" = allCompleted
        ? "ok"
        : anyCompleted || anyTimeout
          ? "partial"
          : "error";

      return jsonResult({
        status,
        results,
      });
    },
  };
}
