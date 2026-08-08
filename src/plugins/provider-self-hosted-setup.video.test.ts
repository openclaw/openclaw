// Native video discovery/setup has its own suite to keep general provider tests bounded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
} from "./provider-self-hosted-setup.js";
import type { ProviderAuthMethodNonInteractiveContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(async () => null),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("self-hosted native video capabilities", () => {
  it.each([
    {
      description: "provider input modalities",
      metadata: { input_modalities: ["text", "image", "video", "audio"] },
      input: ["text", "image", "video"],
    },
    {
      description: "camel-case provider input modalities",
      metadata: { inputModalities: ["text", "video"] },
      input: ["text", "video"],
    },
    {
      description: "nested architecture input modalities",
      metadata: { architecture: { input_modalities: ["text", "video"] } },
      input: ["text", "video"],
    },
    {
      description: "directional architecture modality",
      metadata: { architecture: { modality: "text+video->image" } },
      input: ["text", "video"],
    },
    {
      description: "explicit inputs overriding stale modality metadata",
      metadata: {
        input_modalities: ["text"],
        architecture: { modality: "text+image+video->text" },
      },
      input: ["text"],
    },
    {
      description: "output-only video",
      metadata: { architecture: { modality: "text->image+video" } },
      input: ["text"],
    },
  ])(
    "preserves only explicitly advertised executable $description",
    async ({ metadata, input }) => {
      const release = vi.fn(async () => undefined);
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "local/video-capable-model", ...metadata }] }),
          { status: 200 },
        ),
        finalUrl: "https://provider.example/v1/models",
        release,
      });

      const [model] = await discoverOpenAICompatibleLocalModels({
        baseUrl: "https://provider.example/v1",
        label: "custom provider",
        discoverRuntimeContext: false,
        env: {},
      });

      expect(model?.input).toEqual(input);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("retains explicitly provided native-video capability in self-hosted model config", async () => {
    const ctx: ProviderAuthMethodNonInteractiveContext = {
      authChoice: "vllm",
      config: { agents: { defaults: {} } },
      baseConfig: { agents: { defaults: {} } },
      opts: { customModelId: "Qwen/Qwen3-VL" },
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      agentDir: "/tmp/openclaw-self-hosted-test-agent",
      resolveApiKey: vi.fn<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>(async () => ({
        key: "self-hosted-test-key",
        source: "flag",
      })),
      toApiKeyCredential: vi.fn<ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]>(
        ({ provider, resolved }) => ({
          type: "api_key",
          provider,
          key: resolved.key,
        }),
      ),
    };

    const cfg = await configureOpenAICompatibleSelfHostedProviderNonInteractive({
      ctx,
      providerId: "vllm",
      providerLabel: "vLLM",
      defaultBaseUrl: "http://127.0.0.1:8000/v1",
      defaultApiKeyEnvVar: "VLLM_API_KEY",
      modelPlaceholder: "Qwen/Qwen3-VL",
      input: ["text", "image", "video"],
    });

    expect(cfg?.models?.providers?.["vllm"]?.models[0]?.input).toEqual(["text", "image", "video"]);
  });
});
