import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { isAnthropicOAuthApiKey } from "@openclaw/ai/internal/anthropic";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  context as anthropicContext,
  anthropicEvents,
  createAnthropicResponse,
} from "../packages/ai/src/provider-transport-parity.test-support.js";
import {
  resolveProviderContext,
  type ProviderStreamOptions,
} from "../packages/ai/src/provider-types.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import {
  testing as extraParamsTesting,
  type WrapProviderStreamFnParams,
} from "../src/agents/embedded-agent-runner/extra-params.test-support.js";
import { createModelGenerationFixture } from "../src/agents/embedded-agent-runner/model.generation-scope.test-support.js";
import { prepareEmbeddedAttemptTransport } from "../src/agents/embedded-agent-runner/run/attempt-stream-settle.js";
import { setPreparedModelFullCatalogAuth } from "../src/agents/prepared-model-runtime-auth.js";
import { createPreparedAccountCatalogAccess } from "../src/agents/prepared-model-runtime.catalog-auth.js";
import type { StreamFn } from "../src/agents/runtime/index.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../src/agents/test-helpers/agent-message-fixtures.js";
import "../src/agents/ai-transport-runtime-host.js";
import { bindStreamLlmRuntime } from "../src/llm/model-runtime-binding.js";
import { createCodexNativeWebSearchWrapper } from "../src/llm/providers/stream-wrappers/openai.js";
import { createAssistantMessageEventStream } from "../src/llm/utils/event-stream.js";
import { attachRuntimePromptMediaFacts } from "../src/media/media-facts.js";

const registerProviderStreamForModel = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/provider-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/provider-stream.js")>()),
  registerProviderStreamForModel,
}));

type PrepareTransportInput = Parameters<typeof prepareEmbeddedAttemptTransport>[0];
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
const admittedRunContext = {
  operationalRunInstance: createOperationalRunInstanceRef("test-run"),
};

function transportEnvironment() {
  return {
    settingsManager: { getGlobalSettings: () => ({}) },
    workspaceOnly: false,
    abortSignal: new AbortController().signal,
    codeModeControlsEnabled: false,
    providerPromptState: { state: {}, effectiveContextTokenBudget: 128_000 },
  };
}

function createTransportFixture(
  testCase: {
    compaction?: boolean;
    pruning?: boolean;
    apiKey?: string;
    baseUrl?: string;
  } = {},
) {
  const streamFn = vi.fn<StreamFn>();
  bindStreamLlmRuntime(streamFn, {
    streamSimple: streamFn,
    registry: { getApiProvider: () => undefined },
  } as never);
  const session = {
    agent: {
      streamFn,
      transport: "auto",
    },
  };
  const input = {
    attempt: {
      config: {
        agents: {
          defaults: { contextPruning: { mode: testCase.pruning ? "cache-ttl" : "off" } },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        baseUrl: testCase.baseUrl ?? "https://api.anthropic.com",
      },
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      promptCacheKey: undefined,
      resolvedApiKey: undefined,
      authStorage: { getApiKey: async () => testCase.apiKey ?? "test-api-key" },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
      runId: "run-transport-1",
      admittedRunContext,
      runtimePlan: {
        auth: { forwardedAuthProfileId: undefined },
        transport: {
          resolveExtraParams: ({
            extraParamsOverride,
          }: {
            extraParamsOverride?: Record<string, unknown>;
          }) => ({
            transport: "sse",
            anthropicServerCompaction: testCase.compaction,
            ...extraParamsOverride,
          }),
        },
      },
      sessionId: "sess-transport-1",
    },
    session,
    ...transportEnvironment(),
    providerThinkingLevel: undefined,
    sessionAgentId: "main",
    workspaceDir: "/workspace",
    agentDir: "/agent",
    getProviderRuntimeHandle: () => ({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    }),
    sandboxSessionKey: "agent:main:test",
  } as unknown as PrepareTransportInput;
  return { input, session, streamFn };
}

function createMediaTransportFixture(modelId: string, workspaceDir = "/tmp", agentId = "main") {
  let providerOptions: ProviderStreamOptions | undefined;
  const providerStream = vi.fn<StreamFn>((_model, _context, options) => {
    providerOptions = options as ProviderStreamOptions;
    return createAssistantMessageEventStream();
  });
  bindStreamLlmRuntime(providerStream, {
    streamSimple: providerStream,
    registry: { getApiProvider: () => undefined },
  } as never);
  const session = { agent: { streamFn: providerStream, transport: "auto" } };
  const model = { api: "test-api", provider: "test-provider", id: modelId };
  registerProviderStreamForModel.mockReturnValue(providerStream);
  const input = {
    ...transportEnvironment(),
    attempt: {
      config: {},
      model,
      modelId,
      provider: model.provider,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
      runId: `run-${modelId}`,
      sessionId: `session-${modelId}`,
      admittedRunContext,
      runtimePlan: {
        auth: { forwardedAuthProfileId: undefined },
        transport: { resolveExtraParams: () => ({}) },
      },
    },
    session,
    sessionAgentId: agentId,
    workspaceDir,
    agentDir: workspaceDir,
    getProviderRuntimeHandle: () => ({ provider: model.provider, modelId }),
    sandboxSessionKey: `agent:${agentId}:test`,
  } as unknown as PrepareTransportInput;
  return { input, session, model, getProviderOptions: () => providerOptions };
}

describe("prepareEmbeddedAttemptTransport", () => {
  beforeEach(() => {
    // These cases own prepared auth/config, not runtime plugin discovery.
    extraParamsTesting.setProviderRuntimeDepsForTest({ wrapProviderStreamFn: () => undefined });
  });
  afterEach(() => {
    extraParamsTesting.resetProviderRuntimeDepsForTest();
    registerProviderStreamForModel.mockReset();
  });

  it.each(
    (["private", "shared"] as const).flatMap((source) =>
      (["daybreak_blue", "daybreak_red"] as const).map((program) => ({ source, program })),
    ),
  )(
    "sends $program from a $source API-key catalog and rejects revoked grants",
    async ({ source, program }) => {
      const { input, session } = createTransportFixture({ apiKey: "synthetic-key" });
      const route = {
        provider: "openai",
        modelId: "synthetic-model",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      } as const;
      const credential = { type: "api_key", provider: "openai", key: "synthetic-key" } as const;
      const accountCatalog = createPreparedAccountCatalogAccess(() => true);
      const outcome = {
        provider: "openai",
        profileId: "openai:a",
        status: "ready" as const,
        modelAccessPrograms: [
          {
            runtimeId: "openclaw",
            ...route,
            cyber: [program],
          },
        ],
      };
      if (source === "private") {
        await accountCatalog.acquire({
          profileId: "openai:a",
          credential,
          allowDiscovery: true,
          load: async () => [outcome],
        });
      }
      const generation = createModelGenerationFixture({
        label: "access",
        agentDir: "/agent",
        workspaceDir: "/workspace",
        config: {},
      });
      const snapshot = {
        ...generation.preparedModelRuntime.modelCatalog,
        providerOutcomes: [outcome],
      };
      setPreparedModelFullCatalogAuth(snapshot, {
        authModes: {},
        providerAuthLabels: new Map(),
        authStore: { version: 1, profiles: { "openai:a": credential } },
      });
      Object.assign(input.attempt, {
        provider: "openai",
        modelId: "synthetic-model",
        cyberAccessProgram: program,
        streamParams: { serviceTier: "priority" },
        model: { ...anthropicModel, ...route, id: route.modelId },
        authProfileId: "openai:a",
        authProfileStore: { version: 1, profiles: { "openai:a": credential } },
        preparedModelRuntime: {
          ...generation.preparedModelRuntime,
          modelCatalog: snapshot,
          accountCatalog,
        },
      });
      input.providerThinkingLevel = "high";
      input.attempt.runtimePlan!.auth.modelRoute = route;
      const previousHost = getAiTransportHost();
      const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
      configureAiTransportHost({
        ...previousHost,
        buildModelFetch: () => async (url, init) => {
          const request = new Request(url, init);
          requests.push({ headers: request.headers, payload: await request.json() });
          const completed = {
            type: "response.completed",
            response: { id: "resp-cold", status: "completed", output: [] },
          };
          return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const { buildOpenAIProvider } = await import("../extensions/openai/api.js");
      const provider = buildOpenAIProvider();
      extraParamsTesting.setProviderRuntimeDepsForTest({
        wrapProviderStreamFn: ({ context }) => provider.wrapStreamFn?.(context),
      });
      registerProviderStreamForModel.mockReturnValue(createOpenAIResponsesTransportStreamFn());
      // The Agent passes its selected thinking level as the stream reasoning option.
      const send = async () =>
        session.agent.streamFn(input.attempt.model, { messages: [] }, { reasoning: "high" });
      try {
        await prepareEmbeddedAttemptTransport(input);
        const result = await (await send()).result();
        expect(result.errorMessage).toBeUndefined();
        expect(result.stopReason).toBe("stop");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-key");
        expect(requests[0]?.payload).toMatchObject({
          model: "synthetic-model",
          access_programs: { cyber: program },
          service_tier: "priority",
          reasoning: { effort: "high" },
        });
        if (source === "shared") {
          setPreparedModelFullCatalogAuth(snapshot, {
            authModes: {},
            providerAuthLabels: new Map(),
            authStore: {
              version: 1,
              profiles: { "openai:a": { ...credential, key: "other-account" } },
            },
          });
          await expect(send()).rejects.toThrow("not advertised");
          setPreparedModelFullCatalogAuth(snapshot, {
            authModes: {},
            providerAuthLabels: new Map(),
            authStore: { version: 1, profiles: { "openai:a": credential } },
          });
        }
        await accountCatalog.acquire({
          profileId: "openai:a",
          credential,
          allowDiscovery: true,
          refresh: true,
          load: async () => [],
        });
        await expect(send()).rejects.toThrow("not advertised");
        await expect(prepareEmbeddedAttemptTransport(input)).rejects.toThrow("not advertised");
        expect(requests).toHaveLength(1);
      } finally {
        configureAiTransportHost(previousHost);
      }
    },
  );

  it.each(
    ("daybreak_blue daybreak_red".split(" ") as Array<"daybreak_blue" | "daybreak_red">).flatMap(
      (program) => [true, false].map((revoke) => ({ program, revoke })),
    ),
  )(
    "revalidates $program at managed HTTP egress after async payload preparation (revoke=$revoke)",
    async ({ program, revoke }) => {
      const { input, session } = createTransportFixture({ apiKey: "synthetic-key" });
      const route = {
        provider: "openai",
        modelId: "synthetic-model",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      } as const;
      const credential = { type: "api_key", provider: "openai", key: "synthetic-key" } as const;
      const accountCatalog = createPreparedAccountCatalogAccess(() => true);
      const outcome = {
        provider: "openai",
        profileId: "openai:a",
        status: "ready" as const,
        modelAccessPrograms: [{ runtimeId: "openclaw", ...route, cyber: [program] }],
      };
      await accountCatalog.acquire({
        profileId: "openai:a",
        credential,
        allowDiscovery: true,
        load: async () => [outcome],
      });
      const generation = createModelGenerationFixture({
        label: "access-egress",
        agentDir: "/agent",
        workspaceDir: "/workspace",
        config: {},
      });
      Object.assign(input.attempt, {
        provider: "openai",
        modelId: "synthetic-model",
        cyberAccessProgram: program,
        model: { ...anthropicModel, ...route, id: route.modelId },
        authProfileId: "openai:a",
        authProfileStore: { version: 1, profiles: { "openai:a": credential } },
        preparedModelRuntime: { ...generation.preparedModelRuntime, accountCatalog },
      });
      input.attempt.runtimePlan!.auth.modelRoute = route;
      // A provider-owned async payload hook holds the request after stream admission.
      let releasePayload!: () => void;
      const payloadGate = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      let payloadHeld!: () => void;
      const payloadReached = new Promise<void>((resolve) => {
        payloadHeld = resolve;
      });
      const { buildOpenAIProvider } = await import("../extensions/openai/api.js");
      const provider = buildOpenAIProvider();
      extraParamsTesting.setProviderRuntimeDepsForTest({
        wrapProviderStreamFn:
          ({ context }) =>
          (model, streamContext, options) =>
            (provider.wrapStreamFn?.(context) ?? context.streamFn!)(model, streamContext, {
              ...options,
              onPayload: async (payload, payloadModel) => {
                const next = await options?.onPayload?.(payload, payloadModel);
                payloadHeld();
                await payloadGate;
                return next;
              },
            }),
      });
      registerProviderStreamForModel.mockReturnValue(createOpenAIResponsesTransportStreamFn());
      // Production managed fetch; a mocked global fetch skips DNS and records the only I/O.
      const sent: Array<{ url: string; payload: Record<string, unknown> }> = [];
      const egress = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(url, init);
        sent.push({ url: request.url, payload: await request.json() });
        const completed = {
          type: "response.completed",
          response: { id: "resp-egress", status: "completed", output: [] },
        };
        return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      });
      vi.stubGlobal("fetch", egress);
      try {
        await prepareEmbeddedAttemptTransport(input);
        const stream = await session.agent.streamFn(input.attempt.model, { messages: [] }, {});
        await payloadReached;
        if (revoke) {
          // Same credential, refreshed account evidence without the selected program.
          await accountCatalog.acquire({
            profileId: "openai:a",
            credential,
            allowDiscovery: true,
            refresh: true,
            load: async () => [],
          });
        }
        releasePayload();
        const result = await stream.result();
        if (revoke) {
          // The SDK reports the local egress refusal as a connection failure.
          expect(result.stopReason).toBe("error");
          expect(result.errorMessage).toBe("Connection error.");
          expect(egress).not.toHaveBeenCalled();
          // A retried attempt names the stale grant at stream admission.
          await expect(
            session.agent.streamFn(input.attempt.model, { messages: [] }, {}),
          ).rejects.toThrow("not advertised");
          expect(egress).not.toHaveBeenCalled();
        } else {
          expect(result.errorMessage).toBeUndefined();
          expect(result.stopReason).toBe("stop");
          expect(egress).toHaveBeenCalledOnce();
          expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses");
          expect(sent[0]?.payload).toMatchObject({ access_programs: { cyber: program } });
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("rejects a stale saved Daybreak override before preparing any provider stream", async () => {
    const { input, streamFn } = createTransportFixture();
    input.attempt.provider = "openai";
    input.attempt.model = {
      ...input.attempt.model,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    input.attempt.cyberAccessProgram = "daybreak_blue";
    await expect(prepareEmbeddedAttemptTransport(input)).rejects.toThrow(
      "not advertised for the current account",
    );
    expect(registerProviderStreamForModel).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("lets the provider select transport from the prepared auth flow", async () => {
    const authFlow = "test-subscription";
    const { input, session, streamFn } = createTransportFixture({
      compaction: false,
      apiKey: "test-access-token",
    });
    streamFn.mockReturnValue(createAssistantMessageEventStream());
    registerProviderStreamForModel.mockReturnValue(streamFn);
    input.attempt.runtimePlan!.auth.selectedAuthMode = "oauth";
    input.attempt.runtimePlan!.auth.selectedAuthFlow = authFlow;
    extraParamsTesting.setProviderRuntimeDepsForTest({
      wrapProviderStreamFn: ({ context }) => {
        const base = context.streamFn;
        if (!base) {
          throw new Error("Expected prepared base stream");
        }
        return (model, messages, options) =>
          base(model, messages, {
            ...options,
            transport: context.auth?.authFlow === "test-subscription" ? "sse" : "auto",
          });
      },
    });

    await prepareEmbeddedAttemptTransport(input);
    await session.agent.streamFn(input.attempt.model, { messages: [] }, {});

    expect(streamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ transport: "sse" }),
    );
  });

  it.each([
    {
      compaction: true,
      apiKey: "test-api-key",
      replayEnabled: true,
      pruning: true,
      clearing: true,
    },
    {
      compaction: false,
      apiKey: "test-api-key",
      replayEnabled: false,
      pruning: true,
      clearing: false,
      baseUrl: "https://proxy.example.test/anthropic",
    },
  ])("prepares transport and replay from resolved auth/config: %j", async (testCase) => {
    const { input, session } = createTransportFixture(testCase);

    const result = await prepareEmbeddedAttemptTransport(input);

    expect(result.effectiveAgentTransport).toBe("sse");
    expect(session.agent.transport).toBe("sse");
    expect(result.compactionReplayEnabled).toBe(testCase.replayEnabled);
    expect(result.serverToolClearingEnabled).toBe(testCase.clearing);
  });

  it.each(
    (["openai-responses", "anthropic-messages"] as const).flatMap((api) =>
      [
        { owns: true, configured: undefined, suppressed: true },
        { owns: true, configured: false, suppressed: true },
        { owns: true, configured: true, suppressed: false },
        { owns: false, configured: undefined, suppressed: false },
        { owns: true, configured: true, suppressed: true, trigger: "memory" as const },
      ]
        .filter((scenario) => api === "openai-responses" || !scenario.trigger)
        .map((scenario) =>
          Object.assign(scenario, {
            api,
            suppressed: api === "openai-responses" && scenario.suppressed,
          }),
        ),
    ),
  )("respects OpenAI compaction ownership without changing Anthropic: %j", async (scenario) => {
    const { input, session, streamFn } = createTransportFixture({ apiKey: "sk-synthetic" });
    const responses = scenario.api === "openai-responses";
    input.attempt.model = {
      ...anthropicModel,
      api: scenario.api,
      provider: responses ? "openai" : "anthropic",
      id: responses ? "gpt-5.4" : "claude-sonnet-4-6",
      baseUrl: responses ? "https://api.openai.com/v1" : "https://api.anthropic.com",
    };
    input.attempt.provider = input.attempt.model.provider;
    input.attempt.modelId = input.attempt.model.id;
    input.attempt.trigger = scenario.trigger;
    input.contextEngineInfo = {
      id: "engine",
      name: "Engine",
      ownsCompaction: scenario.owns,
    };
    const parameter = responses ? "responsesServerCompaction" : "anthropicServerCompaction";
    input.attempt.runtimePlan!.transport.resolveExtraParams = () => ({
      [parameter]: scenario.configured,
    });
    const checkpoint = makeAgentAssistantMessage({
      content: [{ type: "text", text: "CE_SELECTED_HISTORY" }],
      providerReplay: {
        v: 1,
        provider: input.attempt.model.provider,
        api: input.attempt.model.api,
        model: input.attempt.model.id,
        data: "opaque-checkpoint",
        baseUrlHash: "synthetic-endpoint-hash",
        type: responses ? "openai-responses-compaction" : "anthropic-compaction",
      },
    });
    const messages = [checkpoint];
    const payload: Record<string, unknown> = { input: [] };
    streamFn.mockImplementation(async (model, _context, options) => {
      await options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    });
    registerProviderStreamForModel.mockReturnValue(streamFn);

    const prepared = await prepareEmbeddedAttemptTransport(input);
    await session.agent.streamFn(input.attempt.model, { messages }, {});

    expect(prepared.compactionReplayEnabled).toBe(
      !scenario.suppressed && scenario.configured !== false,
    );
    expect(prepared.effectiveExtraParams[parameter]).toBe(
      scenario.suppressed ? false : scenario.configured,
    );
    if (responses && scenario.suppressed) {
      expect(prepared.effectiveExtraParams.responsesCompactEndpoint).toBe(false);
    }
    const sent = streamFn.mock.calls.at(-1)?.[1].messages.find((m) => m.role === "assistant");
    expect(sent?.content).toEqual(checkpoint.content);
    expect(sent?.providerReplay).toEqual(
      scenario.suppressed ? undefined : checkpoint.providerReplay,
    );
    expect(checkpoint.providerReplay).toBeDefined();
    if (responses && scenario.configured === true) {
      if (scenario.suppressed) {
        expect(payload).not.toHaveProperty("context_management");
      } else {
        expect(payload.context_management).toEqual([
          { type: "compaction", compact_threshold: 140_000 },
        ]);
      }
    }
  });

  it.each([{ source: "resolved run", resolvedApiKey: "sk-ant-oat01-synthetic-run" }])(
    "gives provider wrappers the $source credential the Anthropic transport sends",
    async ({ resolvedApiKey }) => {
      await import("../src/agents/ai-transport-runtime-host.js");
      const previousHost = getAiTransportHost();
      const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
      configureAiTransportHost({
        ...previousHost,
        buildModelFetch: () => async (_input, init) => {
          if (typeof init?.body !== "string") {
            throw new Error("expected a JSON Anthropic request body");
          }
          requests.push({
            headers: new Headers(init.headers),
            payload: JSON.parse(init.body) as Record<string, unknown>,
          });
          return createAnthropicResponse(anthropicEvents);
        },
      });
      const wrapperApiKeys: unknown[] = [];
      // Stands in for the Anthropic plugin, which publishes installed Claude CLI
      // evidence only after classifying the request credential as OAuth.
      const wrapProviderStreamFn = vi.fn(({ context }: WrapProviderStreamFnParams) => {
        const streamFn = context.streamFn;
        if (!streamFn) {
          throw new Error("expected a provider stream to wrap");
        }
        return ((model, streamContext, options) => {
          wrapperApiKeys.push(options?.apiKey);
          return streamFn(
            model,
            streamContext,
            isAnthropicOAuthApiKey(options?.apiKey)
              ? { ...options, headers: { ...options?.headers, "user-agent": "claude-cli/2.1.400" } }
              : options,
          );
        }) satisfies StreamFn;
      });
      extraParamsTesting.setProviderRuntimeDepsForTest({ wrapProviderStreamFn });
      const { input, session } = createTransportFixture({
        compaction: false,
        apiKey: "sk-ant-oat01-synthetic-profile",
      });
      input.attempt.model = anthropicModel;
      input.attempt.resolvedApiKey = resolvedApiKey;
      const expectedApiKey = resolvedApiKey ?? "sk-ant-oat01-synthetic-profile";

      try {
        await prepareEmbeddedAttemptTransport(input);
        // Agent turns send no credential; the attempt owns it.
        const stream = await session.agent.streamFn(anthropicModel, anthropicContext, {});
        expect((await stream.result()).stopReason).toBe("stop");
      } finally {
        configureAiTransportHost(previousHost);
      }

      expect(wrapProviderStreamFn).toHaveBeenCalledOnce();
      expect(wrapperApiKeys).toEqual([expectedApiKey]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${expectedApiKey}`);
      expect(requests[0]?.headers.get("user-agent")).toBe("claude-cli/2.1.400");
      expect(requests[0]?.payload.system).toContainEqual({
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.400; cc_entrypoint=sdk-cli;",
      });
    },
  );

  it("keeps the run credential out of session-owned fallback streams", async () => {
    // Session-owned streams resolve their own auth; the run credential is not theirs.
    const sessionStream = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    bindStreamLlmRuntime(sessionStream, {
      streamSimple: vi.fn<StreamFn>(),
      registry: { getApiProvider: () => undefined },
    } as never);
    const { input, session } = createTransportFixture({
      compaction: false,
      apiKey: "stored-profile-key",
    });
    session.agent.streamFn = sessionStream;
    input.attempt.model = { ...input.attempt.model, api: "test-api" };

    const result = await prepareEmbeddedAttemptTransport(input);
    await session.agent.streamFn(input.attempt.model, { messages: [] }, {});

    expect(result.streamStrategy).toBe("session-custom");
    expect(sessionStream).toHaveBeenCalledOnce();
    expect(sessionStream.mock.calls[0]?.[2]?.apiKey).toBeUndefined();
  });

  it.each([
    {
      label: "explicit search",
      toolExecutionAllow: ["web_search"],
      expectedSearch: true,
      codeMode: true,
    },
    { label: "no execution", toolExecutionAllow: [], expectedSearch: false, codeMode: true },
  ])("keeps $label authority on the provider payload (code mode=$codeMode)", async (testCase) => {
    const { input, streamFn } = createTransportFixture({ compaction: false });
    input.attempt.model = {
      ...input.attempt.model,
      api: "openai-chatgpt-responses",
      provider: "openai",
      id: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    input.attempt.modelId = input.attempt.model.id;
    input.attempt.provider = input.attempt.model.provider;
    input.attempt.toolExecutionAllow = testCase.toolExecutionAllow;
    input.attempt.config = {
      auth: { profiles: { test: { provider: "openai", mode: "oauth" } } },
      tools: { web: { search: { openaiCodex: { enabled: true } } } },
    };
    input.codeModeControlsEnabled = testCase.codeMode;
    extraParamsTesting.setProviderRuntimeDepsForTest({
      wrapProviderStreamFn: ({ context }) =>
        createCodexNativeWebSearchWrapper(context.streamFn, context),
    });
    const functionTools = ["exec", "wait"].map((name) => ({
      type: "function",
      name,
      description: name,
      parameters: Type.Object({}),
    }));
    const payload: { tools: Array<Record<string, unknown>> } = { tools: [...functionTools] };
    const foregroundFunctionSchemas = JSON.stringify(functionTools);
    streamFn.mockImplementation(async (model, _context, options) => {
      await options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    });

    await prepareEmbeddedAttemptTransport(input);
    await input.session.agent.streamFn?.(
      input.attempt.model,
      { messages: [], tools: functionTools },
      {},
    );

    expect(JSON.stringify(payload.tools.filter((tool) => tool.type === "function"))).toBe(
      foregroundFunctionSchemas,
    );
    expect(payload.tools.some((tool) => tool.type === "web_search")).toBe(testCase.expectedSearch);
  });

  it("materializes native video from the prepared session agent workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transport-video-"));
    const videoPath = path.join(workspaceDir, "history.mp4");
    await fs.writeFile(videoPath, MP4);
    const { input, session, model, getProviderOptions } = createMediaTransportFixture(
      "test-model-video",
      workspaceDir,
      "marketing",
    );
    input.attempt.config = { agents: { entries: { marketing: { workspace: workspaceDir } } } };

    try {
      await prepareEmbeddedAttemptTransport(input);
      const message = attachRuntimePromptMediaFacts(
        castAgentMessage({ role: "user", content: [{ type: "text", text: "inspect" }] }),
        [{ kind: "video", path: videoPath, contentType: "video/mp4" }],
      );
      const context = { systemPrompt: "system", messages: [message], tools: [] };

      await session.agent.streamFn(model as never, context as never, {});
      const provider = await resolveProviderContext(context as never, getProviderOptions());

      expect(provider.messages[0]?.content).toEqual([
        { type: "text", text: "inspect" },
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records image hydration failures at the provider handoff", async () => {
    const { input, session, model, getProviderOptions } =
      createMediaTransportFixture("test-model-image");
    const onCurrentTurnImageFailure = vi.fn();
    input.onCurrentTurnImageFailure = onCurrentTurnImageFailure;
    await prepareEmbeddedAttemptTransport(input);
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "%%%", mimeType: "image/png" },
        ],
      }),
      [{ kind: "image" }],
      ["inline"],
    );
    const context = { systemPrompt: "system", messages: [message], tools: [] };

    await session.agent.streamFn(model as never, context as never, {});
    const provider = await resolveProviderContext(context as never, getProviderOptions());

    expect(onCurrentTurnImageFailure).toHaveBeenCalledWith(1);
    expect(provider.messages[0]?.content).toEqual([
      { type: "text", text: "inspect" },
      {
        type: "text",
        text: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
      },
    ]);
  });
});
