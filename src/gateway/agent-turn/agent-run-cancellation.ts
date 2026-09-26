import { err, ok } from "@openclaw/normalization-core/result";
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import type { FollowupExecution } from "../../agents/subagents/completion/session-followup-completion.types.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import type { AgentTurnContext } from "./types.js";

/** A confirmed stop joins this exact native producer, even after its caller closes. */
export function createGatewayAgentRunCancellation(params: {
  runId: string;
  entry: ChatAbortControllerEntry | undefined;
  identity:
    | Pick<
        ChatAbortControllerEntry,
        "operationalRunInstance" | "lifecycleGeneration" | "sessionKey"
      >
    | undefined;
  controller: AbortController;
  expectedSessionKey: string | null | undefined;
  context: AgentTurnContext;
  onAborted: (reason: string) => void;
  completion: () => Promise<{ settled: boolean; terminalOutcome: AgentRunTerminalOutcome }>;
}): FollowupExecution["cancel"] {
  const { entry } = params;
  if (!entry || !params.identity || entry.controller !== params.controller) {
    return undefined;
  }
  const { operationalRunInstance, lifecycleGeneration, sessionKey } = params.identity;
  return async (reason, assertCallerCurrent) => {
    const authority = entry.agentRunDelegatedAuthority;
    if (
      !operationalRunInstance ||
      !lifecycleGeneration ||
      !sessionKey ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
      params.context.chatAbortControllers.get(params.runId) !== entry ||
      entry.controller !== params.controller ||
      entry.lifecycleGeneration !== lifecycleGeneration ||
      entry.operationalRunInstance !== operationalRunInstance ||
      entry.sessionKey !== sessionKey ||
      params.expectedSessionKey !== sessionKey ||
      entry.registrationCleanupRequested ||
      (entry.executionStarted && !authority) ||
      (authority &&
        (authority.operationalRunInstance !== operationalRunInstance ||
          !validateAgentRunDelegatedAuthority(authority)))
    ) {
      return err("Followup no longer owns an active Gateway run.");
    }
    assertCallerCurrent();
    const result = abortChatRunById(createChatAbortOps(params.context), {
      runId: params.runId,
      sessionKey,
      stopReason: "rpc",
    });
    if (!result.aborted) {
      return err("Gateway run did not accept cancellation.");
    }
    params.onAborted(reason);
    const outcome = await withTimeout(
      params.completion(),
      10_000,
      "Gateway cancellation settlement",
    );
    if (
      !outcome.settled ||
      classifyAgentRunTerminalOutcome(outcome.terminalOutcome) !== "cancellation"
    ) {
      return err("Gateway cancellation was not confirmed. Inspect its final result.");
    }
    return ok(undefined);
  };
}
