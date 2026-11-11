import type { AssistantMessage, Context } from "@openclaw/llm-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { configureAiTransportHost, getAiTransportHost } from "../packages/ai/src/host.js";
import { makeProviderModel } from "../packages/ai/src/providers/provider-model.test-support.js";
import { cleanupSessionResources } from "../packages/ai/src/session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "../packages/ai/src/transports/openai-responses-client.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { readResponsesInputReplayState } from "../packages/ai/src/transports/openai-responses-input-replay.js";
import type { SdkResponse } from "../packages/ai/src/transports/openai-responses-sdk.test-support.js";
import {
  completedResponse,
  userMessage,
  wireMessage,
} from "../packages/ai/src/transports/openai-stream-cases.test-support.js";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.js";
import { resolveModelCyberAccessProgramDefault } from "../src/agents/model-catalog-access-programs.js";
import { createResourceLoader } from "../src/agents/sessions/agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "../src/agents/sessions/auth-storage.js";
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
} from "../src/agents/sessions/extensions/types.js";
import { ModelRegistry } from "../src/agents/sessions/model-registry.js";
import { createAgentSession } from "../src/agents/sessions/sdk.js";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { text, toolResult } from "../src/agents/sessions/session-message-fixtures.test-support.js";
import { SettingsManager } from "../src/agents/sessions/settings-manager.js";
import { createZeroUsageFixture } from "../src/agents/test-helpers/usage-fixtures.js";
import {
  createOpenAIFastModeWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAITextVerbosityWrapper,
} from "../src/llm/providers/stream-wrappers/openai.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../src/shared/immutable-data.js";

const sdk = vi.hoisted(() => ({
  outcomes: [] as SdkResponse[],
  requests: [] as Array<Record<string, unknown>>,
}));
vi.mock("openai", async () => {
  const { createResponsesSdkMock } =
    await import("../packages/ai/src/transports/openai-responses-sdk.test-support.js");
  return createResponsesSdkMock(sdk);
});

const model = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 200_000,
});
const retainedOutput = "A retained tool result must not be encoded again.";
const editedOutput = "Extension edited the request, leaving saved history intact.";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: 1,
  };
}

async function createSession() {
  let extensionApi: ExtensionAPI | undefined;
  const resourceLoader = await createResourceLoader((api) => {
    extensionApi = api;
    api.on("tool_result", () => {});
  });
  const manager = SessionManager.inMemory();
  const auth = AuthStorage.inMemory();
  auth.setRuntimeApiKey(model.provider, "synthetic-key");
  const registry = ModelRegistry.inMemory(auth);
  const coreStream = createOpenAITextVerbosityWrapper(
    createOpenAIFastModeWrapper(
      createOpenAIResponsesContextManagementWrapper(createOpenAIResponsesTransportStreamFn(), {
        responsesServerCompaction: false,
      }),
    ),
    "low",
  );
  const cyber = resolveModelCyberAccessProgramDefault({
    config: {},
    provider: model.provider,
    modelId: model.id,
    runtimeId: "openclaw",
    route: {
      api: model.api,
      baseUrl: model.baseUrl,
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    },
  });
  expect(cyber).toBe("standard");
  const wrapStreamFn = buildOpenAIProvider().wrapStreamFn;
  assert(wrapStreamFn);
  registry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: (...args) => {
      const result = coreStream(...args);
      assert(result instanceof AssistantMessageEventStream);
      return result;
    },
  });
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "low",
    systemPrompt: "Stable instructions",
    tools: [],
    sessionManager: manager,
    modelRegistry: registry,
    resourceLoader,
    settingsManager: SettingsManager.inMemory({
      transport: "sse",
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  const stream = wrapStreamFn({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn: session.agent.streamFn,
    nativeWebSearchAllowedByToolPolicy: false,
    extraParams: { accessPrograms: { cyber } },
  });
  assert(stream);
  session.agent.streamFn = stream;
  const checkpoint = assistant([]);
  captureOpenAIResponsesCompaction(
    checkpoint,
    { type: "compaction", encrypted_content: "synthetic checkpoint" },
    0,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, { sessionId: manager.getSessionId() }),
  );
  const history: Context["messages"] = [
    checkpoint,
    userMessage("retained question"),
    assistant([{ type: "toolCall", id: "call_read", name: "read", arguments: {} }]),
    toolResult(retainedOutput, "call_read"),
  ].map(freezeJsonSnapshot);
  session.agent.state.messages = history;
  return { session, resourceLoader, history, getExtensionApi: () => extensionApi! };
}

it("keeps session prefixes reusable while extension payload handlers change", async () => {
  const initialHost = getAiTransportHost();
  configureAiTransportHost({
    ...initialHost,
    immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
    // Managed routes replay full input instead of reducing it to previous_response_id.
    requiresManagedTransport: () => true,
  });
  const sessions: Array<Awaited<ReturnType<typeof createSession>>> = [];
  try {
    const first = await createSession();
    sessions.push(first);
    const control = await createSession();
    sessions.push(control);
    const request = async (owner: typeof first) => {
      const responseId = `response_${owner.session.agent.state.messages.length}`;
      sdk.outcomes.push({
        data: (async function* () {
          yield completedResponse(responseId, [wireMessage(`msg_${responseId}`, "done")], {
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          });
        })(),
        response: new Response(null, { status: 200 }),
      });
      const stringify = vi.spyOn(JSON, "stringify");
      let encodings: number;
      try {
        await owner.session.prompt("next turn");
        encodings = stringify.mock.calls.filter(([value]) => value === retainedOutput).length;
      } finally {
        stringify.mockRestore();
      }
      const reply = owner.session.agent.state.messages.at(-1);
      assert(reply?.role === "assistant");
      expect(reply.stopReason).toBe("stop");
      const fingerprint = asOptionalRecord(
        readResponsesInputReplayState(reply)?.contextUsage,
      )?.prefixHash;
      expect(fingerprint).toBeTypeOf("string");
      const input = sdk.requests.at(-1)?.input as Array<{ type: string; output?: string }>;
      expect(sdk.requests.at(-1)?.access_programs).toEqual({ cyber: "standard" });
      return {
        encodings,
        fingerprint,
        output: input.find((item) => item.type === "function_call_output")?.output,
      };
    };
    await request(first);
    await request(control);
    expect((await request(first)).encodings).toBe(0);
    expect((await request(control)).encodings).toBe(0);

    const editPayload = ({ payload }: BeforeProviderRequestEvent) => {
      const input = (payload as { input: Array<{ type: string; output?: string }> }).input;
      const result = input.find((item) => item.type === "function_call_output");
      assert(result);
      result.output = editedOutput;
    };
    first.getExtensionApi().on("before_provider_request", editPayload);
    const changed = await request(first);
    const unchanged = await request(control);
    expect(changed.output).toBe(editedOutput);
    expect(unchanged).toMatchObject({ output: retainedOutput, encodings: 0 });
    expect(changed.fingerprint).not.toBe(unchanged.fingerprint);
    expect(first.history.at(-1)?.content).toEqual(text(retainedOutput));

    first.resourceLoader.getExtensions().extensions[0]!.handlers.delete("before_provider_request");
    const restored = await request(first);
    const matching = await request(control);
    expect(restored).toEqual(matching);
    expect(restored.encodings).toBe(0);

    await first.session.reload();
    expect((await request(first)).encodings).toBe(0);
    first.getExtensionApi().on("before_provider_request", editPayload);
    expect((await request(first)).output).toBe(editedOutput);
    expect(first.history.at(-1)?.content).toEqual(text(retainedOutput));
  } finally {
    for (const owner of sessions) {
      owner.session.dispose();
    }
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
  }
});
