/**
 * Response Router for A2A (RFC-A2A-RESPONSE-ROUTING)
 *
 * Listens for agent lifecycle "end" events and delivers responses
 * to the `returnTo` session specified in skill_invocation payloads.
 */

import { callGateway } from "../gateway/call.js";
import { logger } from "../logging/logger.js";
import {
  onAgentEvent,
  getAgentRunContext,
  clearAgentRunContext,
  type AgentEventPayload,
} from "./agent-events.js";

const log = logger.child({ module: "response-router" });

type SkillResponse = {
  kind: "skill_response";
  correlationId: string;
  taskId: string;
  status: "completed" | "error" | "timeout";
  output?: unknown;
  confidence?: number;
  assumptions?: string[];
  caveats?: string[];
  error?: string;
};

type SkillTimeout = {
  kind: "skill_timeout";
  correlationId: string;
  taskId: string;
  status: "timeout";
  message: string;
};

let responseRouterStarted = false;

/**
 * Extract text from assistant message content blocks.
 * Handles both string content and array of content blocks.
 */
function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const msg = message as Record<string, unknown>;

  // If content is a string, return it directly
  if (typeof msg.content === "string" && msg.content.trim()) {
    return msg.content;
  }

  // If content is an array of blocks, extract text
  if (Array.isArray(msg.content)) {
    const textBlocks = msg.content.filter(
      (block: unknown) =>
        block && typeof block === "object" && (block as Record<string, unknown>).type === "text",
    );
    const texts = textBlocks.map((block: unknown) => {
      const b = block as Record<string, unknown>;
      return typeof b.text === "string" ? b.text : "";
    });
    return texts.join("").trim() || null;
  }

  return null;
}

/**
 * Parse structured response from agent output.
 * Expects JSON with output, confidence, assumptions, caveats.
 */
function parseStructuredResponse(raw: string): {
  output: unknown;
  confidence: number;
  assumptions: string[];
  caveats: string[];
} {
  // Try to parse as JSON
  try {
    const parsed = JSON.parse(raw);
    return {
      output: parsed.output ?? parsed.result ?? parsed,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      caveats: Array.isArray(parsed.caveats) ? parsed.caveats : [],
    };
  } catch {
    // Not JSON, return as raw output
    return {
      output: raw,
      confidence: 0.5,
      assumptions: [],
      caveats: [],
    };
  }
}

/**
 * Deliver a skill_response or skill_timeout message to a target session.
 */
async function deliverToSession(
  targetSessionKey: string,
  message: SkillResponse | SkillTimeout,
): Promise<boolean> {
  try {
    await callGateway({
      method: "sessions.send",
      params: {
        sessionKey: targetSessionKey,
        message: JSON.stringify(message),
        deliver: false, // Don't deliver to channel, just add to session context
      },
      timeoutMs: 10_000,
    });
    log.info(
      { correlationId: message.correlationId, targetSessionKey },
      "Response delivered to session",
    );
    return true;
  } catch (err) {
    log.error(
      { err, correlationId: message.correlationId, targetSessionKey },
      "Failed to deliver response to session",
    );
    return false;
  }
}

/**
 * Handle agent lifecycle "end" event.
 * If the run has a returnTo context, fetch the response and deliver it.
 */
async function handleLifecycleEnd(evt: AgentEventPayload): Promise<void> {
  const runId = evt.runId;
  const context = getAgentRunContext(runId);

  if (!context?.returnTo || !context.correlationId) {
    // No response routing configured for this run
    return;
  }

  const { returnTo, correlationId, timeout } = context;
  const status = evt.data?.aborted
    ? "timeout"
    : evt.data?.phase === "error"
      ? "error"
      : "completed";

  log.info({ runId, correlationId, returnTo, status }, "Lifecycle end with response routing");

  // Handle timeout case
  if (status === "timeout") {
    await deliverToSession(returnTo, {
      kind: "skill_timeout",
      correlationId,
      taskId: runId,
      status: "timeout",
      message: `Agent call timed out after ${timeout ?? 60000}ms`,
    });
    clearAgentRunContext(runId);
    return;
  }

  // Handle error case
  if (status === "error") {
    await deliverToSession(returnTo, {
      kind: "skill_response",
      correlationId,
      taskId: runId,
      status: "error",
      error: typeof evt.data?.error === "string" ? evt.data.error : "Agent error",
    });
    clearAgentRunContext(runId);
    return;
  }

  // Handle success case - fetch the response from the session
  if (!context.sessionKey) {
    log.warn({ runId, correlationId }, "No sessionKey in context, cannot fetch response");
    clearAgentRunContext(runId);
    return;
  }

  try {
    // Fetch the last assistant message from the session
    const history = await callGateway<{ messages: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey: context.sessionKey, limit: 10 },
      timeoutMs: 5_000,
    });

    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const lastAssistant = messages
      .filter((m: unknown) => {
        if (!m || typeof m !== "object") {
          return false;
        }
        return (m as Record<string, unknown>).role === "assistant";
      })
      .pop();

    const raw = extractAssistantText(lastAssistant);

    if (!raw) {
      await deliverToSession(returnTo, {
        kind: "skill_response",
        correlationId,
        taskId: runId,
        status: "error",
        error: "Agent returned empty or invalid response",
      });
      clearAgentRunContext(runId);
      return;
    }

    const { output, confidence, assumptions, caveats } = parseStructuredResponse(raw);

    await deliverToSession(returnTo, {
      kind: "skill_response",
      correlationId,
      taskId: runId,
      status: "completed",
      output,
      confidence,
      assumptions,
      caveats,
    });
  } catch (err) {
    log.error({ err, runId, correlationId }, "Failed to fetch and deliver response");
    await deliverToSession(returnTo, {
      kind: "skill_response",
      correlationId,
      taskId: runId,
      status: "error",
      error: err instanceof Error ? err.message : "Failed to fetch response",
    });
  }

  clearAgentRunContext(runId);
}

/**
 * Start the response router.
 * Should be called once at gateway startup.
 */
export function startResponseRouter(): void {
  if (responseRouterStarted) {
    return;
  }
  responseRouterStarted = true;

  onAgentEvent((evt: AgentEventPayload) => {
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase !== "end" && phase !== "error") {
      return;
    }
    // Handle async to not block the event loop
    handleLifecycleEnd(evt).catch((err) => {
      log.error({ err, runId: evt.runId }, "Error in response router");
    });
  });

  log.info("Response router started");
}

/**
 * Stop the response router (for testing).
 */
export function resetResponseRouter(): void {
  responseRouterStarted = false;
}
