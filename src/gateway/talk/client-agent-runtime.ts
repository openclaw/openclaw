import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";

const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [embeddedAgent, admission] = await Promise.all([
    import("../../agents/embedded-agent.js"),
    import("../../agents/admitted-run-context.js"),
  ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
  };
});

export function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  rawSourceRef?: string;
  assertCurrent?: () => void;
  getAdditionalSystemPrompt?: () => string | undefined;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
}) {
  const agentRuntime = createPluginRuntime().agent;
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (runParams) => {
    runParams.abortSignal?.throwIfAborted();
    const execution = await loadTalkAgentExecution();
    runParams.abortSignal?.throwIfAborted();
    const { agentId, sessionId, sessionKey, storePath } = runParams.sessionTarget ?? {};
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      throw new Error("Talk consult requires its prepared transcript target");
    }
    const operationalRunInstance = execution.createOperationalRunInstanceRef(runParams.runId);
    params.assertCurrent?.();
    params.bindOperationalRunInstance?.(operationalRunInstance);
    const preparedRunAdmission = execution.prepareAgentRunAdmission({
      cfg: params.config,
      operationalRunInstance,
      facts: {
        runId: runParams.runId,
        agentId,
        ingress: {
          kind: "gateway-client",
          boundary: "talk-agent-consult",
          state: "present",
          ...(params.rawSourceRef ? { rawSourceRef: params.rawSourceRef } : {}),
        },
      },
    });
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        preparedRunAdmission.close();
      }
    };
    // Abort owns authority revocation independently of core completion; the
    // post-registration check closes the prepare-to-listener race.
    runParams.abortSignal?.addEventListener("abort", close, { once: true });
    try {
      runParams.abortSignal?.throwIfAborted();
      // Provider-owned work can outlive or replace its audio transport. Unlike
      // chat-backed Talk, it has no independent Chat terminal delivery; hiding
      // its final transcript would lose the answer when no spoken replacement arrives.
      return await execution.runEmbeddedAgent({
        ...runParams,
        extraSystemPrompt: [runParams.extraSystemPrompt, params.getAdditionalSystemPrompt?.()]
          .filter(Boolean)
          .join("\n\n"),
        preparedRunAdmission,
        // Speech is mirrored separately. Keep generated input in current-turn custody,
        // but never display it or replay it as a later user request.
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
          input: {
            text: runParams.prompt,
            display: false,
            excludeFromContext: true,
            idempotencyKey: buildRunUserTurnIdempotencyKey(runParams.runId),
          },
          target: {
            agentId,
            sessionId,
            sessionKey,
            storePath,
            expectedSessionId: sessionId,
            sessionEntry: undefined,
            config: params.config,
            cwd: runParams.workspaceDir,
          },
        }),
      });
    } finally {
      // Accepted terminal writes commit under this admission; abort still closes it immediately.
      try {
        await drainAgentRunTerminalWrites(operationalRunInstance);
      } finally {
        runParams.abortSignal?.removeEventListener("abort", close);
        close();
      }
    }
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}
