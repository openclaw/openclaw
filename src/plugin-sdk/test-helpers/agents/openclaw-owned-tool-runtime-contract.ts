import { vi } from "vitest";
import { resetAdjustedParamsByToolCallIdForTests } from "../../../agents/agent-tools.before-tool-call.state.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  markExited,
  recordNotifyOnExitRemoval,
} from "../../../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../../../agents/bash-process-registry.test-helpers.js";
import { createExecTool } from "../../../agents/bash-tools.exec-run.js";
import { createRunExit } from "../../../agents/bash-tools.exec-runtime.test-support.js";
import { createProcessTool } from "../../../agents/bash-tools.process.js";
import { resolveCurrentAttemptAssistant } from "../../../agents/embedded-agent-runner/run/attempt-terminal-evidence.js";
import { createEmbeddedRunContextRecoveryState } from "../../../agents/embedded-agent-runner/run/context-recovery-state.js";
import { buildEmbeddedRunPayloads } from "../../../agents/embedded-agent-runner/run/payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "../../../agents/embedded-agent-runner/run/terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "../../../agents/embedded-agent-runner/run/terminal-preparation.js";
import { mergeAttemptToolMediaPayloads } from "../../../agents/embedded-agent-runner/run/tool-media-payloads.js";
import type { EmbeddedRunAttemptResult } from "../../../agents/embedded-agent-runner/run/types.js";
import { createUsageAccumulator } from "../../../agents/embedded-agent-runner/usage-accumulator.js";
import { createAdmittedHostCapabilityTestFixture } from "../../../agents/harness/host-capability.test-support.js";
import type { AgentToolResult } from "../../../agents/runtime/index.js";
import type { ToolErrorSummary } from "../../../agents/tool-error-summary.js";
import { setToolTerminalPresentation } from "../../../agents/tool-terminal-presentation.js";
import type { AnyAgentTool } from "../../../agents/tools/common.js";
import { getCoreTtsAttemptResultMediaUrls } from "../../../agents/tools/tts-tool-result-provenance.js";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
} from "../../../infra/system-events.js";
import type { AgentToolResultMiddlewareEvent } from "../../../plugins/agent-tool-result-middleware-types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../../../process/supervisor/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as ttsRuntime from "../../../tts/tts.js";

export { createToolTerminalObserver as createContractToolTerminalObserver } from "../../../agents/tool-terminal-outcome.js";

type ToolResult = AgentToolResult<unknown>;

/** Real process poll producer and notification queue, with a synthetic completed process. */
export function createProcessPollDeliveryContract(sessionId: string) {
  const sessionKey = `agent:main:${sessionId}`;
  const session = createProcessSessionFixture({ id: sessionId, backgrounded: true });
  session.scopeKey = sessionKey;
  session.sessionKey = sessionKey;
  addSession(session);
  appendOutput(session, "stdout", "completed output");
  markExited(session, 0, null, "completed");
  enqueueSystemEventWithReceipt("unrelated event", { sessionKey, contextKey: "other" });
  recordNotifyOnExitRemoval(
    session,
    enqueueSystemEventWithReceipt("exec completed", { sessionKey, contextKey: sessionId })!,
  );
  return {
    tool: createProcessTool({ scopeKey: sessionKey }),
    pollArguments: { action: "poll", sessionId },
    pendingNotifications: () => peekSystemEventEntries(sessionKey).map((event) => event.text),
    close: () => {
      deleteSession(sessionId);
      drainSystemEventEntries(sessionKey);
    },
  };
}

/** Real exec producer; only OS execution is controlled for native adapter proof. */
export function createRequiredExecRuntimeContract() {
  const started = createDeferredCore();
  const exit = createDeferredCore<RunExit>();
  const stdout = "REQUIRED_NATIVE_RESULT";
  let input: SpawnInput | undefined;
  let settled = false;
  const finish = (reason: RunExit["reason"] = "exit") => {
    if (settled) {
      return;
    }
    settled = true;
    input?.onStdout?.(stdout);
    exit.resolve(createRunExit({ reason, exitCode: reason === "exit" ? 0 : null, stdout }));
  };
  const spawn = vi.spyOn(getProcessSupervisor(), "spawn").mockImplementation(async (next) => {
    input = next;
    return {
      runId: next.runId ?? "required-native-command",
      startedAtMs: Date.now(),
      activity: {
        get resultSettled() {
          return settled;
        },
        lastOutputAtMs: Date.now(),
      },
      wait: () => {
        started.resolve();
        return exit.promise;
      },
      cancel: () => finish("manual-cancel"),
    };
  });
  return {
    tool: createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      bypassHostApprovalFloors: true,
      allowBackground: true,
      notifyOnExit: false,
    }),
    started: started.promise,
    finish,
    spawn,
    close: () => {
      finish();
      spawn.mockRestore();
    },
  };
}

export function textToolResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

type ContractToolParams = {
  name: string;
  result: ToolResult;
};

function createContractTool(
  params: ContractToolParams,
  label = `${params.name} contract tool`,
): AnyAgentTool {
  return {
    name: params.name,
    label,
    description: label,
    parameters: {},
    execute: vi.fn(async () => params.result),
  } as AnyAgentTool;
}

export function createTerminalPresentationContractTool(
  params: ContractToolParams & {
    format: (params: unknown, result: ToolResult) => string | undefined;
  },
): AnyAgentTool {
  return setToolTerminalPresentation(createContractTool(params), (toolParams, result) => {
    const text = params.format(toolParams, result);
    return text ? { text } : undefined;
  });
}

export function createOwnerBackedContractTool(
  params: ContractToolParams & { pluginId: string; trustedLocalMedia?: boolean },
): AnyAgentTool {
  const tool = createContractTool(params, `${params.name} owner contract tool`);
  tool.parameters = { type: "object", properties: {}, additionalProperties: true };
  setPluginToolMeta(tool, {
    pluginId: params.pluginId,
    optional: false,
    sideEffecting: true,
    ...(params.trustedLocalMedia === true ? { trustedLocalMedia: true } : {}),
  });
  return tool;
}

export function buildContractReplyPayloads(
  params:
    | { assistantText: string; lastToolError?: ToolErrorSummary }
    | Pick<Parameters<typeof prepareEmbeddedRunTerminal>[0], "attempt" | "runParams">,
) {
  if ("attempt" in params) {
    const { attempt, runParams } = params;
    const provider = runParams.provider ?? "codex";
    const model = runParams.model ?? "runtime-contract";
    // Use the terminal owner so canonical assistant/segment selection and tool
    // media merging stay identical to ordinary final delivery.
    return (
      prepareEmbeddedRunTerminal({
        attempt,
        runParams,
        currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
        provider,
        model,
        activeErrorContext: { provider, model },
        authProfileStore: { version: 1, profiles: {} },
        sessionIdUsed: attempt.sessionIdUsed,
        outerContextTokenMeta: {},
        usageAccumulator: createUsageAccumulator(),
        contextRecoveryState: createEmbeddedRunContextRecoveryState(),
        resolvedToolResultFormat: "plain",
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt,
          assistant: resolveCurrentAttemptAssistant(attempt),
          abortSignal: runParams.abortSignal,
        }),
      }).payloadsWithToolMedia ?? []
    );
  }
  return buildEmbeddedRunPayloads({
    assistantTexts: [params.assistantText],
    lastAssistant: undefined,
    lastToolError: params.lastToolError,
    sessionKey: "session:runtime-contract",
  });
}

export function installOpenClawOwnedToolHooks(params?: {
  adjustedParams?: Record<string, unknown>;
  blockReason?: string;
}) {
  const beforeToolCall = vi.fn(async () => {
    if (params?.blockReason) {
      return { block: true, blockReason: params.blockReason };
    }
    return params?.adjustedParams ? { params: params.adjustedParams } : {};
  });
  const afterToolCall = vi.fn(async () => {});
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", handler: beforeToolCall },
      { hookName: "after_tool_call", handler: afterToolCall },
    ]),
  );
  return { beforeToolCall, afterToolCall };
}

/** Installs result middleware only; use installOpenClawOwnedToolHooks for before/after hooks. */
export function installCodexToolResultMiddleware(
  handler: (event: AgentToolResultMiddlewareEvent) => ToolResult,
) {
  const middleware = vi.fn(async (event: AgentToolResultMiddlewareEvent) => ({
    result: handler(event),
  }));
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "runtime-contract",
    pluginName: "Runtime Contract",
    rawHandler: middleware,
    handler: middleware,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
  return { middleware };
}

export function resetOpenClawOwnedToolHooks(): void {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetAdjustedParamsByToolCallIdForTests();
}

/** Real host TTS producer and delivery consumer; only synthesis is synthetic. */
export async function createHostTtsRuntimeContract(
  attempt: Parameters<typeof createAdmittedHostCapabilityTestFixture>[0],
  audioPath: string,
  options: { nativeModelPolicySupport?: "exact" } = {},
) {
  const host = await createAdmittedHostCapabilityTestFixture(attempt, options);
  const synthesis = vi.spyOn(ttsRuntime, "textToSpeech").mockResolvedValue({
    success: true,
    audioPath,
    provider: "test-speech",
    audioAsVoice: true,
  });
  return {
    hostCapabilities: host.hostCapabilities,
    synthesis,
    deliverablePayloads: (result: EmbeddedRunAttemptResult) =>
      (
        mergeAttemptToolMediaPayloads({
          toolMediaUrls: result.toolMediaUrls,
          hostOwnedToolMediaUrls: result.hostOwnedToolMediaUrls,
          toolAutoDeliveryMediaUrls: getCoreTtsAttemptResultMediaUrls(
            result,
            result.toolMediaUrls,
            host.admittedRunContext.operationalRunInstance,
          ),
          toolAudioAsVoice: result.toolAudioAsVoice,
          toolTrustedLocalMedia: result.toolTrustedLocalMedia,
          sourceReplyDeliveryMode: "message_tool_only",
        }) ?? []
      ).filter((payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression),
    close: () => {
      host.closeHost();
      host.closeAdmission();
      synthesis.mockRestore();
    },
  };
}
