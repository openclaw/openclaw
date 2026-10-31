import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { LlmCompleteParams } from "./types-core.js";

const mocks = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  select: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/simple-completion-runtime.js")>()),
  acquireSimpleCompletionModelForAgent: mocks.acquire,
  resolveSimpleCompletionSelectionForAgent: mocks.select,
}));

const modelId = "gpt-5.6-luna";
const responseModel = "gpt-5.6-luna-2026-08-01";
const authToken = `${[
  { alg: "none", typ: "JWT" },
  { "https://api.openai.com/auth": { chatgpt_account_id: "acct-runtime-model-test" } },
]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
  .join(".")}.signature`;

const cfg = { agents: { defaults: { model: `openai/${modelId}` } } } satisfies OpenClawConfig;

const policy = { allowModelOverride: true, allowedModels: [`openai/${modelId}`] };
const pluginCfg = {
  ...cfg,
  plugins: { entries: { "trusted-plugin": { llm: policy } } },
} satisfies OpenClawConfig;
const selection = { provider: "openai", modelId, agentDir: "/tmp/openclaw-agent" };
const verdict = '{"classification":"safe","reason":"fixture"}';

function preparedOauthModel(
  profileId = "openai:test-oauth",
): Extract<Awaited<ReturnType<typeof mocks.acquire>>, { model: unknown }> {
  return {
    [Symbol.asyncDispose]: vi.fn(async () => {}),
    selection: { ...selection, profileId },
    model: makeProviderModelFixture({
      provider: "openai",
      id: modelId,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
    }),
    auth: { apiKey: authToken, source: "test", mode: "oauth", profileId },
  };
}

function completedResponse(): Response {
  const response = {
    id: "resp_runtime_model",
    object: "response",
    status: "completed",
    output: [
      {
        id: "msg_runtime_model",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: verdict, annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.completed", response },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream", "openai-model": responseModel },
    },
  );
}

let previousHost: ReturnType<typeof getAiTransportHost>;
let completionWork: AsyncWorkScope;
const modelFetch = vi.fn<typeof fetch>();

function complete(
  request: Partial<Extract<LlmCompleteParams, { execution?: undefined }>> = {},
  hostId = "runtime-test",
) {
  const llm = createRuntimeLlm({
    getConfig: () => cfg,
    authority: { caller: { kind: "host", id: hostId }, allowComplete: true },
  });
  return completionWork.track(() =>
    llm.complete({
      messages: [{ role: "user", content: "Ping" }],
      requiredAuthMode: "oauth",
      ...request,
    }),
  );
}

function selectOverride(preparedProfile = "openai:work") {
  mocks.select.mockReturnValueOnce({ ...selection, profileId: "openai:work" });
  const prepared = preparedOauthModel(preparedProfile);
  mocks.acquire.mockResolvedValueOnce(prepared);
  return prepared;
}

function completeOverride() {
  const llm = createRuntimeLlm({ getConfig: () => pluginCfg, authority: { allowComplete: true } });
  return completionWork.track(() =>
    withPluginRuntimePluginScope({ pluginId: "trusted-plugin" }, () =>
      llm.complete({
        model: `openai/${modelId}@openai:work`,
        messages: [{ role: "user", content: "Ping" }],
        requiredAuthMode: "oauth",
      }),
    ),
  );
}

beforeEach(async () => {
  completionWork = new AsyncWorkScope();
  // Initialize the lazily loaded agent host before installing the fixture override;
  // otherwise the first completion replaces this host and selects native WebSocket.
  await import("../../agents/ai-transport-runtime-host.js");
  previousHost = getAiTransportHost();
  modelFetch.mockReset().mockImplementation(async () => completedResponse());
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => modelFetch,
    plugin: {
      ...previousHost.plugin,
      resolveProviderStream: () => undefined,
      resolveTransportTurnState: () => undefined,
      wrapSimpleCompletionStream: () => undefined,
    },
  });
  mocks.select.mockReset().mockReturnValue(selection);
  mocks.acquire.mockReset().mockResolvedValue(preparedOauthModel());
});

afterEach(async () => {
  // Caller results settle before transport drainage and the acquired model release.
  await completionWork.drain();
  configureAiTransportHost(previousHost);
  vi.restoreAllMocks();
});

describe("runtime.llm.complete managed ChatGPT OAuth model identity", () => {
  it("returns the concrete response model from the managed transport", async () => {
    const result = await complete(
      {
        messages: [{ role: "user", content: "Classify this fixture." }],
        signal: AbortSignal.timeout(30_000),
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "reef_guard_verdict",
            strict: true,
            schema: { type: "object", additionalProperties: false },
          },
        },
      },
      "reef",
    );

    expect(result).toMatchObject({
      text: verdict,
      provider: "openai",
      model: modelId,
      responseModel,
      stopReason: "stop",
    });
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it("binds a direct model override to its selected OAuth profile", async () => {
    selectOverride();
    await expect(completeOverride()).resolves.toMatchObject({ text: verdict });
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: `openai/${modelId}@openai:work`,
        bindAuthOwner: true,
      }),
    );
  });

  it.each([
    ["mode", "selected a credential with the wrong authentication mode"],
    ["profile", "selected a different authentication profile"],
  ])("rejects the wrong auth %s before transport and releases it", async (boundary, error) => {
    const prepared = boundary === "profile" ? selectOverride("openai:other") : preparedOauthModel();
    if (boundary === "mode") {
      mocks.acquire.mockResolvedValueOnce({
        ...prepared,
        auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
      });
    }
    await expect(boundary === "profile" ? completeOverride() : complete()).rejects.toThrow(error);
    await completionWork.drain();
    expect(modelFetch).not.toHaveBeenCalled();
    expect(prepared[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
});
