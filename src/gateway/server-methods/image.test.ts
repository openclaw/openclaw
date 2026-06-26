import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageHandlers } from "./image.js";

vi.mock("../../image-generation/provider-registry.js", () => ({
  listImageGenerationProviders: vi.fn(() => [
    {
      id: "openai",
      label: "OpenAI",
      defaultModel: "dall-e-3",
      models: ["dall-e-3", "dall-e-2"],
      capabilities: {
        generate: true,
        edit: false,
        geometry: { sizes: ["1024x1024"] },
        output: ["png", "webp"],
      },
    },
    {
      id: "gemini",
      label: "Google Gemini",
      models: ["imagen-3"],
      isConfigured: vi.fn(() => true),
      capabilities: {
        generate: { maxCount: 4 },
        edit: true,
        geometry: true,
        output: [],
      },
    },
    {
      id: "replicate",
      label: "Replicate",
      models: [],
      capabilities: { generate: true, edit: false, geometry: false, output: true },
    },
  ]),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: vi.fn(() => "/tmp/agents/main"),
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function respondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

function expectSuccess(respond: ReturnType<typeof vi.fn>): {
  providers: unknown[];
  active: string | null;
} {
  const call = respondCall(respond);
  expect(call[0]).toBe(true);
  return call[1] as { providers: unknown[]; active: string | null };
}

function createInvokeParams(cfg: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await imageHandlers["image.providers"]({
        respond: respond as never,
        context: { getRuntimeConfig: () => cfg } as never,
        params: {},
        client: null,
        req: { type: "req", id: "req-1", method: "image.providers" },
        isWebchatConnect: () => false,
      } as never),
  };
}

describe("imageHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns provider list", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: {} },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    expect(result.providers).toHaveLength(3);
    expect(result.providers[0]).toMatchObject({ id: "openai", label: "OpenAI" });
  });

  it("marks provider configured when auth profile exists", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: { openai: { type: "api-key" } } },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    const openai = result.providers.find((p) => (p as { id: string }).id === "openai");
    expect((openai as { configured: boolean }).configured).toBe(true);
  });

  it("marks provider configured when model config exists", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: { openai: {} } },
      plugins: { entries: {} },
      auth: { profiles: {} },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    const openai = result.providers.find((p) => (p as { id: string }).id === "openai");
    expect((openai as { configured: boolean }).configured).toBe(true);
  });

  it("marks provider configured when plugin config exists", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: { openai: { config: {} } } },
      auth: { profiles: {} },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    const openai = result.providers.find((p) => (p as { id: string }).id === "openai");
    expect((openai as { configured: boolean }).configured).toBe(true);
  });

  it("uses provider isConfigured override when available", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: {} },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    const gemini = result.providers.find((p) => (p as { id: string }).id === "gemini");
    expect((gemini as { configured: boolean }).configured).toBe(true);
  });

  it("resolves active from string format imageGenerationModel", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: { openai: { type: "api-key" } } },
      agents: { defaults: { imageGenerationModel: "openai/dall-e-3" } },
    });
    await invoke();
    const result = expectSuccess(respond);
    expect(result.active).toBe("openai");
  });

  it("resolves active from object format imageGenerationModel.primary", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: { gemini: { type: "api-key" } } },
      agents: { defaults: { imageGenerationModel: { primary: "gemini" } } },
    });
    await invoke();
    const result = expectSuccess(respond);
    expect(result.active).toBe("gemini");
  });

  it("sets active to first configured when no config primary", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: { openai: { type: "api-key" } } },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    expect(result.active).toBe("openai");
  });

  it("sets active to first provider when none configured", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: {} },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    expect(result.active).toBe("gemini");
  });

  it("returns null active when config primary is not configured", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: {} },
      agents: { defaults: { imageGenerationModel: "unknown-provider" } },
    });
    await invoke();
    const result = expectSuccess(respond);
    expect(result.active).toBe(null);
  });

  it("returns capabilities with defaults", async () => {
    const { respond, invoke } = createInvokeParams({
      models: { providers: {} },
      plugins: { entries: {} },
      auth: { profiles: {} },
      agents: {},
    });
    await invoke();
    const result = expectSuccess(respond);
    const replicate = result.providers.find((p) => (p as { id: string }).id === "replicate");
    expect((replicate as { capabilities: unknown }).capabilities).toMatchObject({
      generate: true,
      edit: false,
      geometry: false,
      output: true,
    });
  });
});
