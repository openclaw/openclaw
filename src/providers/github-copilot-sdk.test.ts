import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @github/copilot-sdk before importing the module under test
// ---------------------------------------------------------------------------

const mockClient = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue([]),
  ping: vi.fn().mockResolvedValue({ message: "pong", timestamp: Date.now() }),
  getAuthStatus: vi.fn().mockResolvedValue({
    isAuthenticated: true,
    authType: "gh-cli",
    host: "github.com",
    login: "testuser",
    statusMessage: "Authenticated",
  }),
  listModels: vi.fn().mockResolvedValue([
    {
      id: "gpt-4o",
      name: "GPT-4o",
      capabilities: {
        supports: { vision: true, reasoningEffort: false },
        limits: { max_context_window_tokens: 128000, max_prompt_tokens: 8192 },
      },
      policy: { state: "enabled", terms: "" },
      billing: { multiplier: 1 },
    },
    {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      capabilities: {
        supports: { vision: true, reasoningEffort: false },
        limits: { max_context_window_tokens: 200000, max_prompt_tokens: 8192 },
      },
      policy: { state: "enabled", terms: "" },
    },
    {
      id: "o3-mini",
      name: "O3 Mini",
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: { max_context_window_tokens: 128000, max_prompt_tokens: 4096 },
      },
      policy: { state: "enabled", terms: "" },
    },
    {
      id: "disabled-model",
      name: "Disabled Model",
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 32000 },
      },
      policy: { state: "disabled", terms: "" },
    },
  ]),
};

class MockCopilotClient {
  constructor() {
    return mockClient;
  }
}

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: MockCopilotClient,
}));

// ---------------------------------------------------------------------------
// Import module under test — must be AFTER vi.mock()
// ---------------------------------------------------------------------------

import {
  ensureCopilotSdkClient,
  stopCopilotSdkClient,
  getCopilotSdkAuthStatus,
  isCopilotSdkAvailable,
  discoverCopilotModelsViaSdk,
  buildCopilotModelDefinitionFromSdk,
  _resetForTesting,
} from "./github-copilot-sdk.js";

describe("github-copilot-sdk (provider layer)", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    // Re-configure happy-path defaults
    mockClient.start.mockResolvedValue(undefined);
    mockClient.stop.mockResolvedValue([]);
    mockClient.ping.mockResolvedValue({ message: "pong", timestamp: Date.now() });
    mockClient.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      authType: "gh-cli",
      host: "github.com",
      login: "testuser",
      statusMessage: "Authenticated",
    });
  });

  afterEach(async () => {
    await stopCopilotSdkClient();
    _resetForTesting();
  });

  // -----------------------------------------------------------------------
  // Client lifecycle
  // -----------------------------------------------------------------------

  describe("ensureCopilotSdkClient", () => {
    it("creates and starts a client on first call", async () => {
      const client = await ensureCopilotSdkClient();
      expect(client).toBeTruthy();
      expect(mockClient.start).toHaveBeenCalledTimes(1);
    });

    it("reuses the same client on subsequent calls", async () => {
      const first = await ensureCopilotSdkClient();
      const second = await ensureCopilotSdkClient();
      expect(first).toBe(second);
      expect(mockClient.start).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent start calls", async () => {
      const [a, b, c] = await Promise.all([
        ensureCopilotSdkClient(),
        ensureCopilotSdkClient(),
        ensureCopilotSdkClient(),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(mockClient.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("stopCopilotSdkClient", () => {
    it("stops the shared client", async () => {
      await ensureCopilotSdkClient();
      await stopCopilotSdkClient();
      expect(mockClient.stop).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no client exists", async () => {
      await stopCopilotSdkClient();
      expect(mockClient.stop).not.toHaveBeenCalled();
    });

    it("allows creating a new client after stop", async () => {
      await ensureCopilotSdkClient();
      await stopCopilotSdkClient();
      mockClient.start.mockClear();
      await ensureCopilotSdkClient();
      expect(mockClient.start).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Auth status
  // -----------------------------------------------------------------------

  describe("getCopilotSdkAuthStatus", () => {
    it("returns authenticated status from SDK", async () => {
      const status = await getCopilotSdkAuthStatus();
      expect(status).toEqual({
        authenticated: true,
        login: "testuser",
        host: "github.com",
        authType: "gh-cli",
        message: "Authenticated",
      });
    });

    it("returns unauthenticated when SDK says not authenticated", async () => {
      mockClient.getAuthStatus.mockResolvedValue({
        isAuthenticated: false,
        statusMessage: "Not signed in",
      });
      const status = await getCopilotSdkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.message).toBe("Not signed in");
    });

    it("returns unauthenticated when SDK throws", async () => {
      mockClient.getAuthStatus.mockRejectedValue(new Error("spawn failed"));
      const status = await getCopilotSdkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.message).toContain("SDK auth check failed");
    });
  });

  describe("isCopilotSdkAvailable", () => {
    it("returns true when client can be pinged", async () => {
      expect(await isCopilotSdkAvailable()).toBe(true);
    });

    it("returns false when start fails", async () => {
      mockClient.start.mockRejectedValue(new Error("not installed"));
      expect(await isCopilotSdkAvailable()).toBe(false);
    });

    it("returns false when ping fails", async () => {
      mockClient.ping.mockRejectedValue(new Error("timeout"));
      expect(await isCopilotSdkAvailable()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Model discovery
  // -----------------------------------------------------------------------

  describe("buildCopilotModelDefinitionFromSdk", () => {
    it("converts vision model correctly", () => {
      const def = buildCopilotModelDefinitionFromSdk({
        id: "gpt-4o",
        name: "GPT-4o",
        capabilities: {
          supports: { vision: true, reasoningEffort: false },
          limits: { max_context_window_tokens: 128000, max_prompt_tokens: 8192 },
        },
      });

      expect(def.id).toBe("gpt-4o");
      expect(def.name).toBe("GPT-4o");
      expect(def.api).toBe("openai-responses");
      expect(def.reasoning).toBe(false);
      expect(def.input).toEqual(["text", "image"]);
      expect(def.contextWindow).toBe(128000);
      expect(def.maxTokens).toBe(8192);
      expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("converts reasoning model correctly", () => {
      const def = buildCopilotModelDefinitionFromSdk({
        id: "o3-mini",
        name: "O3 Mini",
        capabilities: {
          supports: { vision: false, reasoningEffort: true },
          limits: { max_context_window_tokens: 128000, max_prompt_tokens: 4096 },
        },
      });

      expect(def.reasoning).toBe(true);
      expect(def.input).toEqual(["text"]);
      expect(def.maxTokens).toBe(4096);
    });

    it("uses model id as name when name is empty", () => {
      const def = buildCopilotModelDefinitionFromSdk({
        id: "some-model",
        name: "",
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 64000 },
        },
      });
      expect(def.name).toBe("some-model");
    });

    it("uses defaults when limits are missing", () => {
      const def = buildCopilotModelDefinitionFromSdk({
        id: "minimal",
        name: "Minimal",
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 32000 },
        },
      });
      expect(def.contextWindow).toBe(32000);
      expect(def.maxTokens).toBe(8192); // default
    });
  });

  describe("discoverCopilotModelsViaSdk", () => {
    it("returns SDK models, filtering out disabled ones", async () => {
      const models = await discoverCopilotModelsViaSdk();
      expect(models).not.toBeNull();
      expect(models!.length).toBe(3); // gpt-4o, claude-sonnet-4, o3-mini (disabled excluded)
      expect(models!.map((m) => m.id)).toEqual(["gpt-4o", "claude-sonnet-4", "o3-mini"]);
    });

    it("returns null when SDK returns empty list", async () => {
      mockClient.listModels.mockResolvedValue([]);
      const models = await discoverCopilotModelsViaSdk();
      expect(models).toBeNull();
    });

    it("returns null when SDK throws", async () => {
      mockClient.listModels.mockRejectedValue(new Error("auth failed"));
      const models = await discoverCopilotModelsViaSdk();
      expect(models).toBeNull();
    });

    it("returns null when SDK returns null", async () => {
      mockClient.listModels.mockResolvedValue(null);
      const models = await discoverCopilotModelsViaSdk();
      expect(models).toBeNull();
    });
  });
});
