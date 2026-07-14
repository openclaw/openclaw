// Operator-initiated transcript injection: `chat.inject` (synthetic assistant
// message) and `chat.injectBashExecution` (TUI-local `!`/`!!` shell result).
// Both share the same session-resolution + work-admission shape and the same
// first-turn precondition, so they live behind one seam off the chat hub.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatInjectBashExecutionParams,
  validateChatInjectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { sendGlobalAwareNodeChatPayload } from "./chat-broadcast.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import { appendInjectedBashExecutionMessageToTranscript } from "./chat-transcript-inject.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Params for persisting a TUI-local `!`/`!!` shell command result, no agent turn involved. */
export type InjectBashExecutionParams = {
  sessionKey: string;
  agentId?: string;
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  /** Resolves runtime config for agent-scoped ("global") session-key parsing. */
  getRuntimeConfig?: () => OpenClawConfig;
};

export type InjectBashExecutionResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/**
 * Shared core for `chat.injectBashExecution`: session resolution, work admission, and
 * transcript append. Exported so the embedded (in-process) TUI backend can call it
 * directly without a gateway RPC round trip, mirroring how `chat.send` is split between
 * the RPC handler and `EmbeddedTuiBackend.sendChat`.
 */
export async function injectBashExecutionTranscriptMessage(
  params: InjectBashExecutionParams,
): Promise<InjectBashExecutionResult> {
  const rawSessionKey = params.sessionKey;
  const requestedAgentId = resolveRequestedChatAgentId({
    cfg: params.getRuntimeConfig?.(),
    requestedSessionKey: rawSessionKey,
    agentId: params.agentId,
  });
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const {
    cfg,
    storePath,
    entry,
    canonicalKey: sessionKey,
  } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
  const selectedAgent = validateChatSelectedAgent({
    cfg,
    requestedSessionKey: rawSessionKey,
    agentId: requestedAgentId,
  });
  if (!selectedAgent.ok) {
    return { ok: false, error: selectedAgent.error };
  }
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    // Sessions with no completed turn have no durable entry yet, and the first
    // turn rewrites the transcript, discarding pre-turn injected rows (same
    // limitation as chat.inject). Failing here keeps the loss visible in the
    // TUI instead of silently dropping the row, and the message must say what
    // to do: the operator is looking at an open session, so a bare "session
    // not found" reads as a routing bug rather than a first-turn precondition.
    return {
      ok: false,
      error: "session has no history yet; send the agent a message first",
    };
  }
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: selectedAgent.agentId,
  });

  let appended: Awaited<ReturnType<typeof appendInjectedBashExecutionMessageToTranscript>>;
  try {
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {
        const latestEntry = loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;
        if (!latestEntry) {
          throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
        }
        if (latestEntry.sessionId !== sessionId) {
          throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
        }
        const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
        if (archivedError) {
          throw new Error(archivedError);
        }
      },
    });
    try {
      appended = await admission.run(
        async () =>
          await appendInjectedBashExecutionMessageToTranscript({
            sessionKey,
            command: params.command,
            output: params.output,
            exitCode: params.exitCode,
            cancelled: params.cancelled,
            truncated: params.truncated,
            fullOutputPath: params.fullOutputPath,
            excludeFromContext: params.excludeFromContext,
            sessionId,
            storePath,
            agentId,
            config: cfg,
          }),
      );
    } finally {
      admission.release();
    }
  } catch (err) {
    return { ok: false, error: formatForLog(err) };
  }
  if (!appended.ok || !appended.messageId) {
    return { ok: false, error: appended.error ?? "unknown error" };
  }
  return { ok: true, messageId: appended.messageId };
}

export const chatInjectHandlers: GatewayRequestHandlers = {
  "chat.injectBashExecution": async ({ params, respond, context }) => {
    if (!validateChatInjectBashExecutionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.injectBashExecution params: ${formatValidationErrors(
            validateChatInjectBashExecutionParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      agentId?: string;
      command: string;
      output: string;
      exitCode?: number;
      cancelled?: boolean;
      truncated?: boolean;
      fullOutputPath?: string;
      excludeFromContext?: boolean;
    };
    const result = await injectBashExecutionTranscriptMessage({
      sessionKey: p.sessionKey,
      agentId: p.agentId,
      command: p.command,
      output: p.output,
      exitCode: p.exitCode,
      cancelled: p.cancelled,
      truncated: p.truncated,
      fullOutputPath: p.fullOutputPath,
      excludeFromContext: p.excludeFromContext,
      getRuntimeConfig: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      return;
    }
    // No live broadcast: the TUI already rendered its own local echo of the
    // command/output as it ran, so re-broadcasting here would double-render
    // it for the originating client (same "shared render path" bug family as
    // #onresume/#result.out). Other connected clients pick this up on their
    // next history reload.
    respond(true, { ok: true, messageId: result.messageId });
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      agentId?: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: p.agentId,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const {
      cfg,
      storePath,
      entry,
      canonicalKey: sessionKey,
    } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });

    let appended: Awaited<ReturnType<typeof appendAssistantTranscriptMessage>>;
    try {
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {
          const latestEntry = loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;
          if (!latestEntry) {
            throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
          }
          if (latestEntry.sessionId !== sessionId) {
            throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
          }
          const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
          if (archivedError) {
            throw new Error(archivedError);
          }
        },
      });
      try {
        appended = await admission.run(
          async () =>
            await appendAssistantTranscriptMessage({
              sessionKey,
              message: p.message,
              label: p.label,
              sessionId,
              storePath,
              sessionFile: entry.sessionFile,
              agentId,
              createIfMissing: true,
              cfg,
            }),
        );
      } finally {
        admission.release();
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      ...(sessionKey === "global" && agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload);
    sendGlobalAwareNodeChatPayload({
      context,
      sessionKey,
      agentId,
      event: "chat",
      payload: chatPayload,
    });

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
