import crypto from "node:crypto";
import { Type } from "typebox";
import { isRequesterParentOfBackgroundAcpSession } from "../../acp/session-interaction-mode.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookSessionsSendTask } from "../../plugins/types.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  type AssistantReplySnapshot,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import { loadSessionEntryByKey } from "../subagent-announce-delivery.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;

type SessionsSendRouteEntry = Pick<SessionEntry, "acp" | "parentSessionKey" | "spawnedBy">;

function isRequesterParentOfNativeSubagentSession(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
}): boolean {
  if (!params.entry || params.entry.acp || !isSubagentSessionKey(params.targetSessionKey)) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}

function isTerminalAgentWaitTimeout(result: AgentWaitResult): boolean {
  return result.endedAt !== undefined || Boolean(result.stopReason || result.livenessState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readSessionsSendHookTask(
  params: Record<string, unknown>,
  defaults: {
    message: string;
    timeoutSeconds: number;
    announceTimeoutMs: number;
    maxPingPongTurns: number;
    requesterSessionKey?: string;
    requesterChannel?: string;
  },
): PluginHookSessionsSendTask | undefined {
  const rawTask = isRecord(params.task) ? params.task : undefined;
  if (!rawTask) {
    return undefined;
  }
  const rawConstraints = isRecord(rawTask.constraints) ? rawTask.constraints : undefined;
  const rawRuntime = isRecord(rawTask.runtime) ? rawTask.runtime : undefined;
  const rawRequester = isRecord(rawTask.requester) ? rawTask.requester : undefined;
  const rawCancelTarget = isRecord(rawRuntime?.cancelTarget) ? rawRuntime.cancelTarget : undefined;
  return {
    intent: normalizeOptionalString(
      typeof rawTask.intent === "string" ? rawTask.intent : undefined,
    ),
    instructions:
      normalizeOptionalString(
        typeof rawTask.instructions === "string" ? rawTask.instructions : undefined,
      ) ?? defaults.message,
    constraints: {
      timeoutSeconds:
        readOptionalFiniteNumber(rawConstraints?.timeoutSeconds) ?? defaults.timeoutSeconds,
      maxPingPongTurns:
        readOptionalFiniteNumber(rawConstraints?.maxPingPongTurns) ?? defaults.maxPingPongTurns,
    },
    runtime: {
      waitRunId: normalizeOptionalString(
        typeof rawRuntime?.waitRunId === "string" ? rawRuntime.waitRunId : undefined,
      ),
      // Trust boundary: callers may pass arbitrary task/runtime metadata in tool args.
      // Do not propagate caller-supplied roundOneReply into delegated announce seeding;
      // only plugin-owned dispatch results or core-verified reply history may seed it.
      roundOneReply: undefined,
      announceTimeoutMs:
        readOptionalFiniteNumber(rawRuntime?.announceTimeoutMs) ?? defaults.announceTimeoutMs,
      maxPingPongTurns:
        readOptionalFiniteNumber(rawRuntime?.maxPingPongTurns) ?? defaults.maxPingPongTurns,
      cancelTarget: rawCancelTarget
        ? {
            kind: normalizeOptionalString(
              typeof rawCancelTarget.kind === "string" ? rawCancelTarget.kind : undefined,
            ),
            sessionKey: normalizeOptionalString(
              typeof rawCancelTarget.sessionKey === "string"
                ? rawCancelTarget.sessionKey
                : undefined,
            ),
            runId: normalizeOptionalString(
              typeof rawCancelTarget.runId === "string" ? rawCancelTarget.runId : undefined,
            ),
          }
        : undefined,
    },
    requester: {
      sessionKey:
        normalizeOptionalString(
          typeof rawRequester?.sessionKey === "string" ? rawRequester.sessionKey : undefined,
        ) ?? defaults.requesterSessionKey,
      channel:
        normalizeOptionalString(
          typeof rawRequester?.channel === "string" ? rawRequester.channel : undefined,
        ) ?? defaults.requesterChannel,
    },
    correlationId: normalizeOptionalString(
      typeof rawTask.correlationId === "string" ? rawTask.correlationId : undefined,
    ),
    parentRunId: normalizeOptionalString(
      typeof rawTask.parentRunId === "string" ? rawTask.parentRunId : undefined,
    ),
  };
}

async function readSessionsSendBaselineSnapshot(params: {
  sessionKey: string;
  callGateway: GatewayCaller;
}): Promise<{ snapshot?: AssistantReplySnapshot; error?: string }> {
  try {
    return {
      snapshot: await readLatestAssistantReplySnapshot({
        sessionKey: params.sessionKey,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        callGateway: params.callGateway,
      }),
    };
  } catch (err) {
    return { error: formatErrorMessage(err) };
  }
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
}): Promise<{ ok: true; runId: string } | { ok: false; result: ReturnType<typeof jsonResult> }> {
  try {
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (err) {
          const msg = formatErrorMessage(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }
      if (parseSessionThreadInfoFast(resolvedKey).threadId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          sessionKey: displayKey,
        });
      }

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceSessionKey: opts?.agentSessionKey,
        sourceChannel: opts?.agentChannel,
        sourceTool: "sessions_send",
      };
      const sendParams = {
        message: annotateInterSessionPromptText(message, inputProvenance),
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: resolveNestedAgentLaneForSession(resolvedKey),
        extraSystemPrompt: agentMessageContext,
        inputProvenance,
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const maxPingPongTurns = resolvePingPongTurns(cfg);

      // Skip the A2A ping-pong + announce flow when the current caller is the
      // parent of a parent-owned child session it spawned itself and another
      // parent-visible result path already exists.
      //
      // ACP background sessions report through the internal task completion
      // path. Waited native subagent sends return the child reply inline. In
      // both cases treating the child as a peer agent wakes the parent with
      // the child's reply, can generate another user-facing response, and can
      // forward that response back to the child as a new message — producing a
      // ping-pong loop (bounded by maxPingPongTurns, but visible as duplicate
      // conversation output).
      //
      // The skip is gated on requester ownership, not just target type: an
      // unrelated sender that can see the same target (e.g. under
      // `tools.sessions.visibility=all`) must still go through the normal A2A
      // path so it actually receives a follow-up delivery.
      const targetSessionEntry = loadSessionEntryByKey(resolvedKey);
      const skipAcpA2AFlow = isRequesterParentOfBackgroundAcpSession(
        targetSessionEntry,
        effectiveRequesterKey,
      );
      const skipNativeParentA2AFlow =
        timeoutSeconds !== 0 &&
        isRequesterParentOfNativeSubagentSession({
          entry: targetSessionEntry,
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: resolvedKey,
        });
      const skipA2AFlow = skipAcpA2AFlow || skipNativeParentA2AFlow;
      // When the A2A flow is skipped, no follow-up announcement will fire and
      // the reply (when present) is returned inline via the `reply` field.
      // Reflect that in the metadata so the parent LLM does not wait for a
      // second result that will never arrive.
      const delivery = skipA2AFlow
        ? ({ status: "skipped", mode: "announce" } as const)
        : ({ status: "pending", mode: "announce" } as const);

      const startA2AFlow = (
        roundOneReply?: string,
        waitRunId?: string,
        baseline?: AssistantReplySnapshot,
      ) => {
        if (skipA2AFlow) {
          return;
        }
        void runSessionsSendA2AFlow({
          targetSessionKey: resolvedKey,
          displayKey,
          message,
          announceTimeoutMs,
          maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
          baseline,
          roundOneReply,
          waitRunId,
        });
      };

      const hookRunner = getGlobalHookRunner();
      let hookBaselineForFallback: AssistantReplySnapshot | undefined;
      if (hookRunner?.hasHooks("sessions_send")) {
        // Delegated plugins may start and finish the child run before returning a
        // waitRunId. Take a non-fatal pre-hook snapshot so fast completions are
        // not mistaken for the baseline, while direct plugin handling remains
        // independent from core reply-history failures.
        const delegatedBaseline: { snapshot?: AssistantReplySnapshot; error?: string } =
          timeoutSeconds === 0
            ? {}
            : await readSessionsSendBaselineSnapshot({
                sessionKey: resolvedKey,
                callGateway: gatewayCall,
              });
        if (!delegatedBaseline.error) {
          hookBaselineForFallback = delegatedBaseline.snapshot;
        }
        const hookTask = readSessionsSendHookTask(params, {
          message,
          timeoutSeconds,
          announceTimeoutMs,
          maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
        });
        const hookResult = await hookRunner.runSessionsSend(
          {
            sessionKey: resolvedKey,
            target: {
              sessionKey: resolvedKey,
              displayKey,
            },
            message,
            ...(hookTask ? { task: hookTask } : {}),
            rawParams: params,
          },
          {
            requesterSessionKey,
            requesterChannel,
          },
        );
        if (hookResult?.handled) {
          if (hookResult.mode === "direct") {
            return jsonResult(
              isRecord(hookResult.result)
                ? hookResult.result
                : {
                    status: "ok",
                    result: hookResult.result,
                    sessionKey: displayKey,
                  },
            );
          }

          const delegatedWaitRunId = normalizeOptionalString(hookResult.dispatch.waitRunId);
          const delegatedRunId = delegatedWaitRunId ?? hookResult.dispatch.taskId;
          const delegatedRoundOneReply = normalizeOptionalString(hookResult.dispatch.roundOneReply);
          if (timeoutSeconds === 0) {
            startA2AFlow(delegatedRoundOneReply, delegatedWaitRunId);
            return jsonResult({
              runId: delegatedRunId,
              status: "accepted",
              sessionKey: displayKey,
              delivery,
            });
          }
          if (!delegatedWaitRunId) {
            return jsonResult({
              runId: delegatedRunId,
              status: "error",
              error: "Delegated sessions_send hook result missing waitRunId for waited send",
              sessionKey: displayKey,
            });
          }
          if (delegatedBaseline.error && !delegatedRoundOneReply) {
            return jsonResult({
              runId: delegatedRunId,
              status: "error",
              error: `Unable to snapshot delegated sessions_send reply history before dispatch: ${delegatedBaseline.error}`,
              sessionKey: displayKey,
            });
          }
          if (delegatedBaseline.error) {
            const wait = await waitForAgentRun({
              runId: delegatedWaitRunId,
              timeoutMs,
              callGateway: gatewayCall,
            });
            if (wait.status === "timeout") {
              if (!isTerminalAgentWaitTimeout(wait)) {
                startA2AFlow(delegatedRoundOneReply, delegatedWaitRunId);
                return jsonResult({
                  runId: delegatedRunId,
                  status: "accepted",
                  sessionKey: displayKey,
                  delivery,
                });
              }
              return jsonResult({
                runId: delegatedRunId,
                status: "timeout",
                error: wait.error,
                sessionKey: displayKey,
              });
            }
            if (wait.status === "error") {
              return jsonResult({
                runId: delegatedRunId,
                status: "error",
                error: wait.error ?? "agent error",
                sessionKey: displayKey,
              });
            }
            startA2AFlow(delegatedRoundOneReply, delegatedWaitRunId);
            return jsonResult({
              runId: delegatedRunId,
              status: "ok",
              sessionKey: displayKey,
              delivery,
            });
          }
          const delegatedResult = await waitForAgentRunAndReadUpdatedAssistantReply({
            runId: delegatedWaitRunId,
            sessionKey: resolvedKey,
            timeoutMs,
            limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
            baseline: delegatedBaseline.snapshot,
            callGateway: gatewayCall,
          });
          if (delegatedResult.status === "timeout") {
            if (!isTerminalAgentWaitTimeout(delegatedResult)) {
              startA2AFlow(delegatedRoundOneReply, delegatedWaitRunId, delegatedBaseline.snapshot);
              return jsonResult({
                runId: delegatedRunId,
                status: "accepted",
                sessionKey: displayKey,
                delivery,
              });
            }
            return jsonResult({
              runId: delegatedRunId,
              status: "timeout",
              error: delegatedResult.error,
              sessionKey: displayKey,
            });
          }
          if (delegatedResult.status === "error") {
            return jsonResult({
              runId: delegatedRunId,
              status: "error",
              error: delegatedResult.error ?? "agent error",
              sessionKey: displayKey,
            });
          }
          const reply = delegatedResult.replyText;
          startA2AFlow(
            delegatedRoundOneReply ?? reply ?? undefined,
            undefined,
            delegatedBaseline.snapshot,
          );
          return jsonResult({
            runId: delegatedRunId,
            status: "ok",
            reply,
            sessionKey: displayKey,
            delivery,
          });
        }
      }

      // Capture the pre-run assistant snapshot only after plugin hooks declined.
      // Hook-owned direct delivery must not be blocked by local reply-history
      // assumptions, while core fallback still snapshots before starting a run.
      const baselineReply =
        timeoutSeconds === 0
          ? undefined
          : (hookBaselineForFallback ??
            (await readLatestAssistantReplySnapshot({
              sessionKey: resolvedKey,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              callGateway: gatewayCall,
            })));

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        startA2AFlow(undefined, runId, baselineReply);
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          delivery,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;
      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId,
        sessionKey: resolvedKey,
        timeoutMs,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        baseline: baselineReply,
        callGateway: gatewayCall,
      });

      if (result.status === "timeout") {
        if (!isTerminalAgentWaitTimeout(result)) {
          startA2AFlow(undefined, runId, baselineReply);
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            delivery,
          });
        }
        return jsonResult({
          runId,
          status: "timeout",
          error: result.error,
          sessionKey: displayKey,
        });
      }
      if (result.status === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: result.error ?? "agent error",
          sessionKey: displayKey,
        });
      }
      const reply = result.replyText;
      startA2AFlow(reply ?? undefined, undefined, baselineReply);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
      });
    },
  };
}
