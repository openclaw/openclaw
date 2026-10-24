import { createApiRegistry } from "@openclaw/ai";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import { createAssistantMessageEventStream, type Model, type StreamFn } from "@openclaw/llm-core";
import OpenAI from "openai";
import { afterEach, expect, it, vi } from "vitest";
import "../agents/ai-transport-runtime-host.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import { applyLocalNoAuthHeaderOverride } from "../agents/model-auth-model.js";
import {
  attachModelProviderRequestTransport as withRequest,
  getModelProviderRequestTransport,
} from "../agents/provider-request-config.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { sealSecretSentinel } from "../secrets/sentinel.js";

const model = makeProviderModelFixture({
  id: "sentinel-test-model",
  api: "openai-completions",
  provider: "sentinel-test-provider",
  baseUrl: "https://provider.example.invalid/v1",
});
const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
const seal = (value: string) => sealSecretSentinel(value, { label: "simple-completion-test" });
const authModes = ["authorization-bearer", "header"] as const;
function requestAuth(mode: (typeof authModes)[number], value: string) {
  return mode === "authorization-bearer"
    ? { mode, token: value }
    : { mode, headerName: "x-key", value, prefix: "Key " };
}

function closedStream() {
  const stream = createAssistantMessageEventStream();
  stream.end();
  return stream;
}

function prepareProvider(
  source: Model,
  createStreamFn: (model: Model) => StreamFn,
  apiRegistry = createApiRegistry(),
) {
  const prepared = prepareModelForSimpleCompletion({
    apiRegistry,
    model: attachModelProviderRuntimePluginHandle(source, {
      provider: source.provider,
      modelId: source.id,
      plugin: {
        id: model.provider,
        label: "Sentinel boundary test",
        auth: [],
        createStreamFn: (context) => createStreamFn(context.model),
      },
    }),
  });
  return (runtimeModel = prepared, options?: Parameters<StreamFn>[2]) =>
    apiRegistry
      .getApiProvider(prepared.api)!
      .streamSimple({ ...runtimeModel, api: prepared.api }, { messages: [] }, options);
}

afterEach(resetSecretRedactionRegistryForTest);

it.each(authModes)(
  "resolves %s at construction and egress without mutating shared models",
  (mode) => {
    const auth = requestAuth(mode, "request-key");
    const request = {
      headers: { "x-request": seal("request-header") },
      auth: requestAuth(mode, seal("request-key")),
      proxy: { mode: "env-proxy" as const },
      tls: { serverName: "provider.example.invalid" },
    };
    const protectedModel = withRequest(
      { ...model, headers: { "x-visible": seal("visible-header") } },
      request,
    );
    const observe = (received: Model) => {
      expect(received.headers).toEqual({ "x-visible": "visible-header" });
      expect(getModelProviderRequestTransport(received)).toEqual({
        ...request,
        headers: { "x-request": "request-header" },
        auth,
      });
      expect(received.api).toBe(model.api);
    };
    const construction = vi.fn((received: Model) => {
      observe(received);
      return stream;
    });
    const stream = vi.fn<StreamFn>((received, _context, options) => {
      observe(received);
      expect(options?.apiKey).toBe("option-key");
      expect(options?.headers).toEqual({ "x-option": "option-header" });
      return closedStream();
    });
    const apiRegistry = createApiRegistry();
    const builtIn = vi.fn(closedStream);
    apiRegistry.registerApiProvider({ api: model.api, stream: builtIn, streamSimple: builtIn });
    const builtInProvider = apiRegistry.getApiProvider(model.api);
    const complete = prepareProvider(protectedModel, construction, apiRegistry);
    complete(protectedModel, {
      apiKey: seal("option-key"),
      headers: { "x-option": seal("option-header") },
    });
    expect(construction).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(builtIn).not.toHaveBeenCalled();
    expect(apiRegistry.getApiProvider(model.api)).toBe(builtInProvider);
    expect(getModelProviderRequestTransport(protectedModel)).toBe(request);
    expect(protectedModel.headers?.["x-visible"]).toBe(seal("visible-header"));
    expect(request.headers["x-request"]).toBe(seal("request-header"));
  },
);

const badBearer = withRequest(model, { auth: requestAuth("authorization-bearer", unknown) });
it.each([
  ["visible header", { ...model, headers: { "x-visible": unknown } }, false],
  ["request header", withRequest(model, { headers: { "x-request": unknown } }), false],
  ["bearer auth", badBearer, false],
  ["header auth", withRequest(model, { auth: requestAuth("header", unknown) }), false],
  ["bearer auth at egress", badBearer, true],
] as const)(
  "rejects unknown %s sentinels before invoking the plugin",
  (_surface, invalidModel, egress) => {
    const stream = vi.fn(closedStream);
    const construction = vi.fn(() => stream);
    const complete = egress ? prepareProvider(model, construction) : undefined;
    expect(() =>
      complete ? complete(invalidModel) : prepareProvider(invalidModel, construction),
    ).toThrow(/not registered in this process/);
    expect(construction).toHaveBeenCalledTimes(egress ? 1 : 0);
    expect(stream).not.toHaveBeenCalled();
  },
);

it("preserves null header deletion through sentinel resolution and SDK request construction", async () => {
  const source: Model = applyLocalNoAuthHeaderOverride(
    { ...model, headers: { "x-visible": seal("visible-header") } },
    { apiKey: CUSTOM_LOCAL_AUTH_MARKER },
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ id: "test-completion", choices: [] }),
  );
  let request: Promise<unknown> | undefined;
  const complete = prepareProvider(source, () => (received) => {
    const client = new OpenAI({
      apiKey: "synthetic-placeholder",
      baseURL: model.baseUrl,
      defaultHeaders: received.headers,
      maxRetries: 0,
      fetch,
    });
    request = client.chat.completions.create({ model: model.id, messages: [] });
    return closedStream();
  });
  complete();
  await request;
  const sentHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(sentHeaders?.has("authorization")).toBe(false);
  expect(sentHeaders?.get("x-visible")).toBe("visible-header");
  expect(source.headers).toEqual({ Authorization: null, "x-visible": seal("visible-header") });
});
