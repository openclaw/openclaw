import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { modelsHandlers } from "./models.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("does not expose runtime params from catalog rows", async () => {
    const respond = vi.fn();
    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-redact-params",
        method: "models.list",
        params: { view: "all" },
      },
      params: { view: "all" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        loadGatewayModelCatalog: vi.fn(() =>
          Promise.resolve([
            {
              id: "qwen-local",
              name: "Qwen Local",
              provider: "vllm",
              params: { qwenThinkingFormat: "chat-template" },
            },
          ]),
        ),
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      { models: [{ id: "qwen-local", name: "Qwen Local", provider: "vllm" }] },
      undefined,
    );
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

describe("models.probe", () => {
  it("calls configured OpenAI-compatible providers with the selected model", async () => {
    const respond = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("{}", {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe",
        method: "models.probe",
        params: { provider: "xinflo", model: "openai/gpt-5.5" },
      },
      params: { provider: "xinflo", model: "openai/gpt-5.5" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () =>
          ({
            models: {
              providers: {
                xinflo: {
                  api: "openai-completions",
                  baseUrl: "https://models.example.com/v1",
                  apiKey: "test-api-key",
                  models: [{ id: "openai/gpt-5.5", name: "GPT 5.5" }],
                },
              },
            },
          }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-api-key",
        }),
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 8,
          stream: false,
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "xinflo",
        model: "openai/gpt-5.5",
        ok: true,
        status: 200,
      }),
      undefined,
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("baseUrl");
  });

  it("can probe draft provider config before it is saved", async () => {
    const respond = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe-draft",
        method: "models.probe",
        params: { provider: "draft", model: "draft-model" },
      },
      params: {
        provider: "draft",
        model: "draft-model",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://draft.example.com/v1",
          apiKey: "draft-api-key",
          models: [{ id: "draft-model", name: "Draft Model" }],
        },
      },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({ models: { providers: {} } }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://draft.example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer draft-api-key",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "draft", model: "draft-model", ok: true }),
      undefined,
    );
  });

  it("falls back to saved provider credentials when draft config contains redacted secrets", async () => {
    const respond = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe-redacted-draft",
        method: "models.probe",
        params: { provider: "xinflo", model: "gpt-5.5" },
      },
      params: {
        provider: "xinflo",
        model: "gpt-5.5",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://models.example.com/v1",
          apiKey: REDACTED_SENTINEL,
          models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
        },
      },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () =>
          ({
            models: {
              providers: {
                xinflo: {
                  api: "openai-completions",
                  baseUrl: "https://models.example.com/v1",
                  apiKey: "saved-api-key",
                  models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
                },
              },
            },
          }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer saved-api-key",
        }),
      }),
    );
  });

  it("does not send saved provider credentials to a changed draft endpoint", async () => {
    const respond = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe-draft-endpoint",
        method: "models.probe",
        params: { provider: "xinflo", model: "gpt-5.5" },
      },
      params: {
        provider: "xinflo",
        model: "gpt-5.5",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://changed.example.com/v1",
          apiKey: REDACTED_SENTINEL,
          models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
        },
      },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () =>
          ({
            models: {
              providers: {
                xinflo: {
                  api: "openai-completions",
                  baseUrl: "https://models.example.com/v1",
                  apiKey: "saved-api-key",
                  models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
                },
              },
            },
          }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://changed.example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          authorization: "Bearer saved-api-key",
        }),
      }),
    );
  });

  it("applies configured request headers and auth overrides to live probes", async () => {
    const respond = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe-overrides",
        method: "models.probe",
        params: { provider: "xinflo", model: "gpt-5.5" },
      },
      params: { provider: "xinflo", model: "gpt-5.5" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () =>
          ({
            models: {
              providers: {
                xinflo: {
                  api: "openai-completions",
                  baseUrl: "https://models.example.com/v1",
                  apiKey: "unused-default-key",
                  request: {
                    headers: { "X-Proxy-Region": "iad" },
                    auth: {
                      mode: "header",
                      headerName: "api-key",
                      value: "custom-key",
                    },
                  },
                  models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
                },
              },
            },
          }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Proxy-Region": "iad",
          "api-key": "custom-key",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          authorization: "Bearer unused-default-key",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "xinflo", model: "gpt-5.5", ok: true }),
      undefined,
    );
  });

  it("does not inject authorization when the provider disables auth headers", async () => {
    const respond = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe-auth-header-false",
        method: "models.probe",
        params: { provider: "xinflo", model: "gpt-5.5" },
      },
      params: { provider: "xinflo", model: "gpt-5.5" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () =>
          ({
            models: {
              providers: {
                xinflo: {
                  api: "openai-completions",
                  authHeader: false,
                  baseUrl: "https://models.example.com/v1",
                  apiKey: "saved-api-key",
                  models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
                },
              },
            },
          }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          authorization: "Bearer saved-api-key",
        }),
      }),
    );
  });

  it("returns probe failures as data instead of failing the RPC", async () => {
    const respond = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no access to model", { status: 403 })),
    );

    await modelsHandlers["models.probe"]({
      req: {
        type: "req",
        id: "req-models-probe-failed",
        method: "models.probe",
        params: { provider: "xinflo", model: "gpt-5.5" },
      },
      params: { provider: "xinflo", model: "gpt-5.5" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () =>
          ({
            models: {
              providers: {
                xinflo: {
                  api: "openai-completions",
                  baseUrl: "https://models.example.com/v1",
                  apiKey: "test-api-key",
                  models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
                },
              },
            },
          }) as unknown as OpenClawConfig,
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "xinflo",
        model: "gpt-5.5",
        ok: false,
        status: 403,
        message: "no access to model",
      }),
      undefined,
    );
  });
});
