import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { requestPreparedOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGoogleGenerativeAiTransportStreamFn } from "../extensions/google/transport-stream.js";
import {
  PROVIDER_CONTEXT_HANDOFF,
  PROVIDER_MODEL_INPUT,
} from "../packages/ai/src/provider-types.js";
import { streamSimpleGoogleInteractions } from "../packages/ai/src/providers/google-interactions.js";
import { streamMistral } from "../packages/ai/src/providers/mistral.js";
import { streamOpenAICodexResponses } from "../packages/ai/src/providers/openai-chatgpt-responses.js";
import {
  chatgptContext,
  chatgptModel,
  createJwt,
} from "../packages/ai/src/providers/openai-chatgpt-responses.test-helpers.js";
import { wrapStreamFnWithModelRequestGate } from "../src/agents/embedded-agent-runner/model-request-hook.js";
import type { StreamFn } from "../src/agents/runtime/index.js";
import { makeProviderModelFixture } from "../src/agents/test-helpers/provider-model-fixture.js";
import type { PluginHookBeforeModelRequestEvent } from "../src/plugins/hook-model.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../src/plugins/hooks.test-helpers.js";

// Keep the real providers, encoding, hook runner and request policies. Only intercept final I/O.
const { wire } = vi.hoisted(() => ({ wire: vi.fn<typeof fetch>() }));
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/provider-transport-runtime")>()),
  buildGuardedModelFetch: () => wire,
}));
const originalHost = getAiTransportHost();
beforeEach(() => {
  wire.mockReset();
  wire.mockResolvedValue(new Response(null, { status: 204 }));
  configureAiTransportHost({ ...originalHost, buildModelFetch: () => wire });
  vi.stubGlobal("fetch", wire);
});
afterEach(() => {
  resetGlobalHookRunner();
  configureAiTransportHost(originalHost);
  vi.unstubAllGlobals();
});
function install(policy: (event: PluginHookBeforeModelRequestEvent) => unknown) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_model_request",
        handler: (event) => policy(event as PluginHookBeforeModelRequestEvent),
      },
    ]),
  );
}
const context = { messages: [{ role: "user" as const, timestamp: 0, content: "question" }] };
const data = "dGVzdC12aWRlbw==";
const googleModel = (api: "google-interactions" | "google-generative-ai") =>
  Object.assign(
    makeProviderModelFixture({
      api,
      provider: "google",
      id: "gemini-2.5-pro",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    }),
    { input: ["text", "video"] },
  );
const providers: Record<"google-interactions" | "google-generative-ai", StreamFn> = {
  "google-interactions": (model, ctx, options) =>
    streamSimpleGoogleInteractions(
      { ...model, compat: undefined, api: "google-interactions" },
      ctx,
      options,
    ),
  "google-generative-ai": createGoogleGenerativeAiTransportStreamFn(),
};
for (const api of ["google-interactions", "google-generative-ai"] as const) {
  it.each(["allow", "rewrite", "deny", "off"] as const)(
    `${api}: %s materialized video at final I/O`,
    async (action) => {
      const reply =
        api === "google-interactions"
          ? { event_type: "interaction.completed", interaction: { status: "completed" } }
          : { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
      wire.mockResolvedValue(
        new Response(`data: ${JSON.stringify(reply)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
      let policyCalls = 0;
      if (action !== "off") {
        install(({ payload }) => {
          policyCalls++;
          const json = JSON.stringify(payload);
          expect(json).toContain(data);
          if (action === "deny") {
            throw new Error("fixture media not approved");
          }
          if (action === "rewrite") {
            return { payload: JSON.parse(json.replace(data, "cmVkYWN0ZWQ=")) };
          }
          return undefined;
        });
      }
      const ordinary = vi.fn((payload: unknown) => {
        expect(JSON.stringify(payload)).not.toContain(data);
      });
      const options = {
        apiKey: "fixture",
        onPayload: ordinary,
        [PROVIDER_MODEL_INPUT]: ["text", "video"],
        [PROVIDER_CONTEXT_HANDOFF]: async () => ({
          messages: [
            {
              role: "user",
              timestamp: 0,
              content: [{ type: "video", mimeType: "video/mp4", data }],
            },
          ],
        }),
      };
      const stream = await wrapStreamFnWithModelRequestGate(providers[api], {}, "turn")(
        googleModel(api),
        context,
        options,
      );
      const result = await stream.result();
      expect(ordinary).toHaveBeenCalledOnce();
      expect(policyCalls).toBe(action === "off" ? 0 : 1);
      if (action === "deny") {
        expect(result.errorMessage).toContain("fixture media not approved");
        expect(wire).not.toHaveBeenCalled();
      } else {
        expect(result.stopReason).toBe("stop");
        expect(wire).toHaveBeenCalledOnce();
        const body = await new Response(wire.mock.calls[0]![1]?.body).text();
        if (action === "rewrite") {
          expect(body).not.toContain(data);
        }
        expect(body).toContain(action === "rewrite" ? "cmVkYWN0ZWQ=" : data);
      }
    },
  );
}

it.each(["mistral-conversations", "google-interactions"] as const)(
  "%s refuses a native tool-choice change before I/O",
  async (api) => {
    const google = api === "google-interactions";
    const model = google
      ? googleModel(api)
      : makeProviderModelFixture({
          api,
          provider: "mistral",
          id: "mistral-large-latest",
          baseUrl: "https://api.mistral.ai",
        });
    const transport: StreamFn = google
      ? providers["google-interactions"]
      : (m, c, o) => streamMistral({ ...m, compat: undefined, api: "mistral-conversations" }, c, o);
    install(({ payload }) => {
      const body = payload as { toolChoice?: string; generation_config?: { tool_choice?: string } };
      if (google) {
        expect(body.generation_config?.tool_choice).toBe("none");
        body.generation_config!.tool_choice = "auto";
      } else {
        expect(body.toolChoice).toBe("none");
        return { payload: { ...body, toolChoice: "auto" } };
      }
      return undefined;
    });
    const options = { apiKey: "fixture", toolChoice: "none" };
    const stream = await wrapStreamFnWithModelRequestGate(transport, {}, "turn")(
      model,
      context,
      options,
    );
    expect((await stream.result()).errorMessage).toContain(
      "must not change the provider tool surface",
    );
    expect(wire).not.toHaveBeenCalled();
  },
);

it("identifies a native V2 checkpoint on the foreground stream before I/O", async () => {
  const kinds: string[] = [];
  install(({ requestKind }) => {
    kinds.push(requestKind);
    throw new Error("fixture checkpoint withheld");
  });
  const foreground = wrapStreamFnWithModelRequestGate(
    (m, c, o) => streamOpenAICodexResponses({ ...m, api: "openai-chatgpt-responses" }, c, o),
    {},
    "turn",
  );
  await expect(
    requestPreparedOpenAIResponsesCompaction(
      foreground,
      chatgptModel,
      chatgptContext,
      { apiKey: createJwt(), transport: "sse" },
      "v2",
    ),
  ).rejects.toThrow("fixture checkpoint withheld");
  expect(kinds).toEqual(["compaction"]);
  expect(wire).not.toHaveBeenCalled();
});
