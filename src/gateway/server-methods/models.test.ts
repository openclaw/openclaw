import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ErrorCodes } from "../protocol/index.js";
import { modelsHandlers } from "./models.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

describe("models.list", () => {
  it("does not block the configured view on slow model catalog discovery", async () => {
    const catalog = createDeferred<never>();
    const respond = vi.fn();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

    vi.useFakeTimers();
    try {
      const request = modelsHandlers["models.list"]({
        req: {
          type: "req",
          id: "req-models-list-slow-catalog",
          method: "models.list",
          params: { view: "configured" },
        },
        params: { view: "configured" },
        respond,
        client: null,
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => {
            const config = {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://openai.example.com",
                    models: [{ id: "gpt-test", name: "GPT Test" }],
                  },
                },
              },
            };
            return config as unknown as OpenClawConfig;
          },
          loadGatewayModelCatalog,
          logGateway: {
            debug: vi.fn(),
          },
        } as never,
      });

      await vi.advanceTimersByTimeAsync(800);
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              provider: "openai",
            },
          ],
        },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ readOnly: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the all view exact instead of timing out to a partial catalog", async () => {
    const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
    const respond = vi.fn();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

    vi.useFakeTimers();
    try {
      const request = modelsHandlers["models.list"]({
        req: {
          type: "req",
          id: "req-models-list-all-slow-catalog",
          method: "models.list",
          params: { view: "all" },
        },
        params: { view: "all" },
        respond,
        client: null,
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => ({}) as OpenClawConfig,
          loadGatewayModelCatalog,
          logGateway: {
            debug: vi.fn(),
          },
        } as never,
      });

      await vi.advanceTimersByTimeAsync(800);
      expect(respond).not.toHaveBeenCalled();

      catalog.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]);
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        { models: [{ id: "gpt-test", name: "GPT Test", provider: "openai" }] },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ readOnly: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the full catalog for provider-scoped configured view and filters only providers", async () => {
    const catalog = [
      { id: "claude-test", name: "Claude Test", provider: "anthropic" },
      { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai-codex" },
      { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai-codex" },
      { id: "llama-local", name: "Llama Local", provider: "vllm" },
      { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
    ];
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/*": {},
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          "openai-codex": { apiKey: "test-key" },
          vllm: { apiKey: "test-key" },
        },
      },
    } as unknown as OpenClawConfig;

    const configuredRespond = vi.fn();
    const loadConfiguredCatalog = vi.fn(() => Promise.resolve(catalog));
    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-provider-allowlist",
        method: "models.list",
        params: { view: "configured" },
      },
      params: { view: "configured" },
      respond: configuredRespond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: loadConfiguredCatalog,
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    expect(configuredRespond).toHaveBeenCalledWith(
      true,
      {
        models: [
          { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai-codex" },
          { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai-codex" },
          { id: "llama-local", name: "Llama Local", provider: "vllm" },
          { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
        ],
      },
      undefined,
    );
    expect(loadConfiguredCatalog).toHaveBeenCalledWith({ readOnly: false });

    const allRespond = vi.fn();
    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-provider-allowlist-all",
        method: "models.list",
        params: { view: "all" },
      },
      params: { view: "all" },
      respond: allRespond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    expect(allRespond).toHaveBeenCalledWith(true, { models: catalog }, undefined);
  });

  it("scopes the configured view to a per-agent allowlist when agentId is provided", async () => {
    const catalog = [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    ];
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [
          { id: "writer", modelAllowlist: { "anthropic/claude-sonnet-4-6": {} } },
          {
            id: "coder",
            modelAllowlist: {
              "openai/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        ],
      },
      models: {
        providers: {
          anthropic: { apiKey: "k" },
          openai: { apiKey: "k" },
        },
      },
    } as unknown as OpenClawConfig;

    const writerRespond = vi.fn();
    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-per-agent-writer",
        method: "models.list",
        params: { view: "configured", agentId: "writer" },
      },
      params: { view: "configured", agentId: "writer" },
      respond: writerRespond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
        logGateway: { debug: vi.fn() },
      } as never,
    });

    expect(writerRespond).toHaveBeenCalledWith(
      true,
      {
        models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" }],
      },
      undefined,
    );

    const coderRespond = vi.fn();
    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-per-agent-coder",
        method: "models.list",
        params: { view: "configured", agentId: "coder" },
      },
      params: { view: "configured", agentId: "coder" },
      respond: coderRespond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
        logGateway: { debug: vi.fn() },
      } as never,
    });

    expect(coderRespond).toHaveBeenCalledWith(
      true,
      {
        models: [
          { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
          { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        ],
      },
      undefined,
    );

    const defaultRespond = vi.fn();
    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-per-agent-default",
        method: "models.list",
        params: { view: "configured" },
      },
      params: { view: "configured" },
      respond: defaultRespond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
        logGateway: { debug: vi.fn() },
      } as never,
    });

    expect(defaultRespond).toHaveBeenCalledWith(
      true,
      {
        models: [
          { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
          { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        ],
      },
      undefined,
    );
  });

  it("preserves catalog load errors before the timeout fallback wins", async () => {
    const respond = vi.fn();

    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-catalog-error",
        method: "models.list",
        params: { view: "configured" },
      },
      params: { view: "configured" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        loadGatewayModelCatalog: vi.fn(() => Promise.reject(new Error("catalog failed"))),
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    const call = respond.mock.calls.at(0) as
      | [boolean, unknown, { code?: number; message?: string }]
      | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("Error: catalog failed");
  });
});
