import { createApiRegistry } from "@openclaw/ai";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import { createAssistantMessageEventStream, type Model, type StreamFn } from "@openclaw/llm-core";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../agents/ai-transport-runtime-host.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import { applyLocalNoAuthHeaderOverride } from "../agents/model-auth-model.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  type ProviderRequestAuthOverride,
} from "../agents/provider-request-config.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import { sealSecretSentinel } from "../secrets/sentinel.js";

const model: Model = {
  id: "sentinel-test-model",
  name: "Sentinel test model",
  api: "openai-completions",
  provider: "sentinel-test-provider",
  baseUrl: "https://provider.example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const unknownSentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
const seal = (value: string) => sealSecretSentinel(value, { label: "simple-completion-test" });

function closedStream() {
  const stream = createAssistantMessageEventStream();
  stream.end();
  return stream;
}

function withProvider<T>(
  createStreamFn: (model: Model) => StreamFn,
  run: (prepare: (model: Model) => Model) => T,
): T {
  const plugin: ProviderPlugin = {
    id: model.provider,
    label: "Sentinel boundary test",
    auth: [],
    createStreamFn: (context) => createStreamFn(context.model),
  };
  // Use the production prepared-handle contract; no host or secret port is replaced.
  return run((source) =>
    attachModelProviderRuntimePluginHandle(source, {
      provider: source.provider,
      modelId: source.id,
      plugin,
    }),
  );
}

afterEach(resetSecretRedactionRegistryForTest);

describe("simple completion with the production transport host", () => {
  const authModes = ["authorization-bearer", "header"] as const;
  const phases = ["construction", "egress"] as const;

  it.each(authModes.flatMap((mode) => phases.map((phase) => ({ mode, phase }))))(
    "resolves $mode transport credentials at $phase without mutating shared models",
    ({ mode, phase }) => {
      const auth: ProviderRequestAuthOverride =
        mode === "authorization-bearer"
          ? { mode, token: "synthetic-request-credential" }
          : {
              mode,
              headerName: "x-provider-key",
              value: "synthetic-request-credential",
              prefix: "Key ",
            };
      const protectedAuth: ProviderRequestAuthOverride =
        auth.mode === "authorization-bearer"
          ? { ...auth, token: seal(auth.token) }
          : { ...auth, value: seal(auth.value) };
      const request = {
        headers: { "x-request": seal("synthetic-request-header") },
        auth: protectedAuth,
        proxy: { mode: "env-proxy" as const },
        tls: { serverName: "provider.example.invalid" },
      };
      const protectedModel = attachModelProviderRequestTransport(
        { ...model, headers: { "x-visible": seal("synthetic-visible-header") } },
        request,
      );
      expect(Object.getOwnPropertySymbols(protectedModel)).toContain(
        Symbol.for("openclaw.modelProviderRequestTransport"),
      );
      const observe = (received: Model) => {
        expect(received.headers).toEqual({ "x-visible": "synthetic-visible-header" });
        expect(getModelProviderRequestTransport(received)).toEqual({
          ...request,
          headers: { "x-request": "synthetic-request-header" },
          auth,
        });
        expect(received.api).toBe(model.api);
      };
      const construction = vi.fn((received: Model) => {
        if (phase === "construction") {
          observe(received);
        }
        return stream;
      });
      const stream = vi.fn<StreamFn>((received, _context, options) => {
        observe(received);
        expect(options?.apiKey).toBe("synthetic-option-key");
        expect(options?.headers).toEqual({ "x-option": "synthetic-option-header" });
        return closedStream();
      });
      withProvider(construction, (prepare) => {
        const apiRegistry = createApiRegistry();
        const builtIn = vi.fn(closedStream);
        apiRegistry.registerApiProvider({ api: model.api, stream: builtIn, streamSimple: builtIn });
        const prepared = prepareModelForSimpleCompletion({
          apiRegistry,
          model: prepare(phase === "construction" ? protectedModel : model),
        });
        expect(prepared.api).not.toBe(model.api);
        apiRegistry.getApiProvider(prepared.api)!.streamSimple(
          { ...protectedModel, api: prepared.api },
          { messages: [] },
          {
            apiKey: seal("synthetic-option-key"),
            headers: { "x-option": seal("synthetic-option-header") },
          },
        );
        expect(construction).toHaveBeenCalledOnce();
        expect(stream).toHaveBeenCalledOnce();
        expect(builtIn).not.toHaveBeenCalled();
      });
      expect(getModelProviderRequestTransport(protectedModel)).toBe(request);
      expect(protectedModel.headers["x-visible"]).toBe(seal("synthetic-visible-header"));
      expect(request.auth).toEqual(protectedAuth);
      expect(request.headers["x-request"]).toBe(seal("synthetic-request-header"));
    },
  );

  const unknownModels = [
    { surface: "visible header", model: { ...model, headers: { "x-visible": unknownSentinel } } },
    {
      surface: "request header",
      model: attachModelProviderRequestTransport(model, {
        headers: { "x-request": unknownSentinel },
      }),
    },
    {
      surface: "bearer auth",
      model: attachModelProviderRequestTransport(model, {
        auth: { mode: "authorization-bearer", token: unknownSentinel },
      }),
    },
    {
      surface: "header auth",
      model: attachModelProviderRequestTransport(model, {
        auth: { mode: "header", headerName: "x-key", value: unknownSentinel },
      }),
    },
  ];
  it.each(
    unknownModels.flatMap((entry) =>
      phases.map((phase) => ({ surface: entry.surface, model: entry.model, phase })),
    ),
  )("rejects unknown $surface sentinels before plugin $phase", ({ model: invalidModel, phase }) => {
    const stream = vi.fn(closedStream);
    const construction = vi.fn(() => stream);
    withProvider(construction, (prepare) => {
      const apiRegistry = createApiRegistry();
      if (phase === "construction") {
        expect(() =>
          prepareModelForSimpleCompletion({ apiRegistry, model: prepare(invalidModel) }),
        ).toThrow(/not registered in this process/);
        expect(construction).not.toHaveBeenCalled();
      } else {
        const prepared = prepareModelForSimpleCompletion({ apiRegistry, model: prepare(model) });
        expect(() =>
          apiRegistry
            .getApiProvider(prepared.api)!
            .streamSimple({ ...invalidModel, api: prepared.api }, { messages: [] }),
        ).toThrow(/not registered in this process/);
      }
      expect(stream).not.toHaveBeenCalled();
    });
  });

  it("preserves null header deletion through sentinel resolution and SDK request construction", async () => {
    const source: Model = applyLocalNoAuthHeaderOverride(
      { ...model, headers: { "x-visible": seal("synthetic-visible-header") } },
      { apiKey: CUSTOM_LOCAL_AUTH_MARKER, source: "synthetic local test", mode: "api-key" },
    );
    let sentHeaders: Headers | undefined;
    let request: Promise<unknown> | undefined;
    await withProvider(
      () => (received) => {
        const client = new OpenAI({
          apiKey: "synthetic-placeholder",
          baseURL: model.baseUrl,
          defaultHeaders: received.headers,
          maxRetries: 0,
          fetch: async (_url, init) => {
            sentHeaders = new Headers(init?.headers);
            return Response.json({ id: "test-completion", choices: [] });
          },
        });
        request = client.chat.completions.create({ model: model.id, messages: [] });
        return closedStream();
      },
      async (prepare) => {
        const apiRegistry = createApiRegistry();
        const prepared = prepareModelForSimpleCompletion({ apiRegistry, model: prepare(source) });
        apiRegistry.getApiProvider(prepared.api)!.streamSimple(prepared, { messages: [] });
        await request;
      },
    );
    expect(sentHeaders?.has("authorization")).toBe(false);
    expect(sentHeaders?.get("x-visible")).toBe("synthetic-visible-header");
    expect(source.headers?.Authorization).toBeNull();
    expect(source.headers?.["x-visible"]).toBe(seal("synthetic-visible-header"));
  });
});
