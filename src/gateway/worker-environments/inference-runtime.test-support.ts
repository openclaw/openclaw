import { afterEach, expect, vi } from "vitest";
import type { WorkerInferenceStartParams } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import * as sessionAuthRuntime from "../../agents/auth-profiles/session-override.js";
import * as extraParamsRuntime from "../../agents/embedded-agent-runner/extra-params.js";
import * as diagnosticModelCallRuntime from "../../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import * as streamResolutionRuntime from "../../agents/embedded-agent-runner/stream-resolution.js";
import * as modelSelectionRuntime from "../../agents/model-selection.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import * as providerStreamRuntime from "../../agents/provider-stream.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import * as simpleCompletionRuntime from "../../agents/simple-completion-runtime.js";
import { createEmptyPluginMetadataSnapshot } from "../../agents/test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as diagnosticTraceRuntime from "../../infra/diagnostic-trace-context.js";
import { bindModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  executeWorkerInference,
  type WorkerInferenceExecutionParams,
} from "./inference-runtime.js";

type Deps = {
  applyStreamPolicy: typeof extraParamsRuntime.applyExtraParamsToAgent;
  acquireRuntimeLease: typeof preparedRuntime.acquireAgentRunPreparedModelRuntime;
  prepareModel: typeof simpleCompletionRuntime.prepareSimpleCompletionModel;
  resolveSessionAuthSelection: typeof sessionAuthRuntime.resolveSessionAuthSelection;
  resolveProviderStream: typeof providerStreamRuntime.registerProviderStreamForModel;
  resolveStream: typeof streamResolutionRuntime.resolveEmbeddedAgentStream;
};
export type Execution = WorkerInferenceExecutionParams;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

export const PROVIDER = "openai";
export const MODEL = "gpt-5.4";
export const ALIAS = "fast";
export const BASE_URL = "https://chatgpt.com/backend-api";
export const ENDPOINT = `${BASE_URL}/codex`;
export const PROFILE = ["gateway", "profile"].join("-");
export const AUTH_MARKER = ["gateway", "profile", "value"].join("-");
export const SESSION_ID = "session-runtime-test";
export const SESSION_KEY = "agent:runtime-agent:main";
const sessionTarget: BoundAgentRunSessionTarget = {
  agentId: "runtime-agent",
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  storePath: "runtime-sessions.json",
};
export const TOOL_CALL = { type: "toolCall" as const, id: "call-1", name: "lookup", arguments: {} };
const WORKSPACE_BASE = "/gateway-workspace";
export const WORKSPACE = `${WORKSPACE_BASE}/runtime-agent`;

export const config = {
  agents: {
    defaults: {
      model: { primary: `${PROVIDER}/${MODEL}` },
      models: { [`${PROVIDER}/${MODEL}`]: {} },
      workspace: WORKSPACE_BASE,
    },
    list: [
      { id: "main", default: true },
      {
        id: "runtime-agent",
        models: {
          [`${PROVIDER}/${MODEL}`]: { alias: ALIAS, agentRuntime: { id: "openclaw" } },
        },
        params: { temperature: 0.1 },
      },
    ],
  },
} satisfies OpenClawConfig;
export const sessionEntry: SessionEntry = {
  sessionId: SESSION_ID,
  updatedAt: 1,
  authProfileOverride: PROFILE,
  authProfileOverrideSource: "user",
};
const identity: WorkerConnectionIdentity = {
  environmentId: "environment-runtime-test",
  credentialHash: ["credential", "hash", "runtime", "test"].join("-"),
  bundleHash: "bundle-hash-runtime-test",
  sessionId: SESSION_ID,
  runId: "run-runtime-test",
  turnClaim: {
    sessionId: SESSION_ID,
    claimId: "claim-runtime-test",
    runId: "run-runtime-test",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "environment-runtime-test", ownerEpoch: 3 },
  },
  ownerEpoch: 3,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 100_000,
};
export const usage: Usage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0.0001,
    cacheWrite: 0.0002,
    total: 0.0033,
  },
};
export const logicalModel: Model = {
  id: MODEL,
  name: "Approved model",
  api: "openai-chatgpt-responses",
  provider: PROVIDER,
  baseUrl: BASE_URL,
  headers: { "x-gateway-route": "selected" },
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 16_000,
  maxTokens: 1_024,
};
export function request(model = ALIAS): WorkerInferenceStartParams {
  return {
    runEpoch: 3,
    sessionId: SESSION_ID,
    runId: "run-runtime-test",
    turnId: `turn-${model}`,
    modelRef: { provider: PROVIDER, model },
    context: {
      systemPrompt: "Gateway system prompt",
      messages: [{ role: "user", content: "Prepared worker context", timestamp: 10 }],
      tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object" } }],
    },
    options: {
      temperature: 0.25,
      maxTokens: 256,
      reasoning: "low",
      thinkingBudgets: { low: 96 },
    },
  };
}

export function finalMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Gateway response", textSignature: "text-signature" },
      TOOL_CALL,
    ],
    api: logicalModel.api,
    provider: PROVIDER,
    model: MODEL,
    usage,
    stopReason: "stop",
    timestamp: 20,
  };
}

export function providerStream(message = finalMessage(), options: { omitToolEnd?: boolean } = {}) {
  const stream = createAssistantMessageEventStream();
  const fragmented = {
    ...message,
    content: [...message.content.slice(0, -1), { ...TOOL_CALL, id: "", name: "" }],
  } satisfies AssistantMessage;
  stream.push({ type: "text_delta", contentIndex: 0, delta: "Gateway response" });
  stream.push({ type: "toolcall_start", contentIndex: 1, partial: fragmented });
  stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: message });
  if (!options.omitToolEnd) {
    stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: TOOL_CALL, partial: message });
  }
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

export function setup(
  entry: SessionEntry = sessionEntry,
  options: {
    catalogOnlyModel?: boolean;
    pluginRegistry?: PluginRegistry;
    afterModelPreparation?: () => void;
    observeStage?: (
      stage: "factory" | "policy" | "wrapper" | "execution",
      registry: PluginRegistry | null | undefined,
    ) => void;
  } = {},
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100);
  const scope: {
    agentDir?: string;
    agentRuntime?: string;
    authProfile?: string;
    preparedModelRuntime?: boolean;
    prepareWorkspace?: string;
  } = {};
  const preparedModelRuntime = {
    catalogOwner: undefined,
    agentDir: "/gateway-agent",
    activeProjectKeys: [],
    allowGatewaySubagentBinding: true,
    workspaceDir: WORKSPACE,
    config,
    observationConfig: config,
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot: createEmptyPluginMetadataSnapshot(WORKSPACE),
    pluginRegistry: options.pluginRegistry ?? createEmptyPluginRegistry(),
    modelCatalog: {
      entries: [
        { provider: PROVIDER, id: MODEL, name: "Approved model" },
        { provider: PROVIDER, id: "known-but-unapproved", name: "Unapproved model" },
      ],
      routeVariants: [],
    },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
  } satisfies preparedRuntime.PreparedModelRuntimeSnapshot;
  let leasedPreparedModelRuntime: preparedRuntime.PreparedModelRuntimeSnapshot | undefined;
  const prepareModel = vi.fn<Deps["prepareModel"]>(async (modelParams) => {
    if (options.catalogOnlyModel && !modelParams.allowBundledStaticCatalogFallback) {
      return { error: `Unknown model: ${modelParams.provider}/${modelParams.modelId}` };
    }
    scope.agentRuntime = modelParams.agentRuntimeId;
    scope.preparedModelRuntime = modelParams.preparedModelRuntime === leasedPreparedModelRuntime;
    scope.prepareWorkspace = modelParams.workspaceDir;
    options.afterModelPreparation?.();
    return {
      model: bindModelLlmRuntime(logicalModel, {
        registry: {},
        streamSimple: fallbackStream,
      } as never),
      auth: {
        apiKey: AUTH_MARKER,
        profileId: PROFILE,
        source: "gateway agent profile",
        mode: "api-key",
      },
    };
  });
  const resolveAuthSelection = vi.fn<Deps["resolveSessionAuthSelection"]>(async () =>
    entry.authProfileOverride
      ? {
          profileId: entry.authProfileOverride,
          source: entry.authProfileOverrideSource === "auto" ? "auto" : "user",
          routeRequirement: undefined,
        }
      : undefined,
  );
  const observedRegistry = () => getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
  const stream = vi.fn<StreamFn>(() => {
    options.observeStage?.("execution", observedRegistry());
    return providerStream();
  });
  const fallbackStream = vi.fn<StreamFn>(() => providerStream());
  const resolveProviderStream = vi.fn<Deps["resolveProviderStream"]>(() => {
    options.observeStage?.("factory", observedRegistry());
    return stream;
  });
  const resolveStream = vi.fn<Deps["resolveStream"]>((streamParams) => {
    scope.authProfile = streamParams.authProfileId;
    return {
      streamFn: streamParams.providerStreamFn ?? streamParams.currentStreamFn ?? fallbackStream,
      strategy: "provider",
    };
  });
  const applyStreamPolicy = vi.fn<Deps["applyStreamPolicy"]>(() => {
    options.observeStage?.("policy", observedRegistry());
    return { effectiveExtraParams: {}, nativeWebSearchAllowedByToolPolicy: undefined };
  });
  const releaseRuntime = vi.fn(async () => {});
  const acquireRuntimeLease = vi.fn<Deps["acquireRuntimeLease"]>(async (runtimeParams) => {
    scope.agentDir = runtimeParams.agentDir;
    const leased = { ...preparedModelRuntime, agentDir: runtimeParams.agentDir };
    leasedPreparedModelRuntime = leased;
    return {
      snapshot: leased,
      pluginGeneration: {
        configuredCatalogEntries: [],
        inlineProviderModels: [],
        pluginMetadataSnapshot: leased.metadataSnapshot,
        pluginRegistry: leased.pluginRegistry,
      },
      [Symbol.asyncDispose]: releaseRuntime,
    };
  });
  vi.spyOn(sessionAccessor, "loadSessionEntry").mockImplementation((target) => {
    expect(target).toEqual(sessionTarget);
    return entry;
  });
  vi.spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime").mockImplementation(
    acquireRuntimeLease,
  );
  vi.spyOn(modelSelectionRuntime, "resolveDefaultModelForAgent").mockReturnValue({
    provider: PROVIDER,
    model: MODEL,
  });
  vi.spyOn(sessionAuthRuntime, "resolveSessionAuthSelection").mockImplementation(
    resolveAuthSelection,
  );
  vi.spyOn(simpleCompletionRuntime, "prepareSimpleCompletionModel").mockImplementation(
    prepareModel,
  );
  vi.spyOn(providerStreamRuntime, "registerProviderStreamForModel").mockImplementation(
    resolveProviderStream,
  );
  vi.spyOn(streamResolutionRuntime, "resolveEmbeddedAgentStream").mockImplementation(resolveStream);
  vi.spyOn(extraParamsRuntime, "applyExtraParamsToAgent").mockImplementation(applyStreamPolicy);
  vi.spyOn(
    diagnosticModelCallRuntime,
    "wrapStreamFnWithDiagnosticModelCallEvents",
  ).mockImplementation((streamFn) => {
    options.observeStage?.("wrapper", observedRegistry());
    return (...args) => {
      vi.setSystemTime(125);
      return streamFn(...args);
    };
  });
  vi.spyOn(diagnosticTraceRuntime, "createDiagnosticTraceContextFromActiveScope").mockReturnValue({
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
  });
  return {
    applyStreamPolicy,
    executor: executeWorkerInference,
    acquireRuntimeLease,
    prepareModel,
    releaseRuntime,
    resolveAuthSelection,
    scope,
    stream,
  };
}

export function params(
  inferenceRequest: WorkerInferenceStartParams,
  emit: Execution["emit"],
  runtimeConfig: OpenClawConfig = config,
): Execution {
  return {
    identity,
    sessionTarget,
    request: inferenceRequest,
    signal: new AbortController().signal,
    emit,
    isCurrent: () => true,
    config: runtimeConfig,
  };
}
