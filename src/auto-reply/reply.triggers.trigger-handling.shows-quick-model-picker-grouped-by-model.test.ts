import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

const usageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn().mockResolvedValue({
    updatedAt: 0,
    providers: [],
  }),
  formatUsageSummaryLine: vi.fn().mockReturnValue("📊 Usage: Claude 80% left"),
  resolveUsageProviderId: vi.fn((provider: string) => provider.split("/")[0]),
}));

vi.mock("../infra/provider-usage.js", () => usageMocks);

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      contextWindow: 200000,
    },
    {
      provider: "openrouter",
      id: "anthropic/claude-opus-4-5",
      name: "Claude Opus 4.5 (OpenRouter)",
      contextWindow: 200000,
    },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
    { provider: "openai-codex", id: "gpt-5.2", name: "GPT-5.2 (Codex)" },
    { provider: "minimax", id: "MiniMax-M2.1", name: "MiniMax M2.1" },
  ]),
  resetModelCatalogCacheForTest: vi.fn(),
}));

vi.mock("../agents/model-catalog.js", () => modelCatalogMocks);

import { abortEmbeddedPiRun, runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { loadSessionStore } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";

const _MAIN_SESSION_KEY = "agent:main:main";

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockClear();
      vi.mocked(abortEmbeddedPiRun).mockClear();
      return await fn(home);
    },
    { prefix: "clawdbot-triggers-" },
  );
}

function makeCfg(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: join(home, "clawd"),
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: { store: join(home, "sessions.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
  it("shows a quick /model picker listing provider/model pairs", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain("Pick: /model <#> or /model <provider/model>");
      // Each provider/model combo is listed separately for clear selection
      expect(normalized).toContain("anthropic/claude-opus-4-5");
      expect(normalized).toContain("openrouter/anthropic/claude-opus-4-5");
      expect(normalized).toContain("openai/gpt-5.2");
      expect(normalized).toContain("openai-codex/gpt-5.2");
      expect(normalized).toContain("More: /model status");
      expect(normalized).not.toContain("reasoning");
      expect(normalized).not.toContain("image");
    });
  });
  it("orders provider/model pairs by provider preference", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      const anthropicIndex = normalized.indexOf("anthropic/claude-opus-4-5");
      const openrouterIndex = normalized.indexOf("openrouter/anthropic/claude-opus-4-5");
      const openaiIndex = normalized.indexOf("openai/gpt-4.1-mini");
      const codexIndex = normalized.indexOf("openai-codex/gpt-5.2");
      expect(anthropicIndex).toBeGreaterThanOrEqual(0);
      expect(openrouterIndex).toBeGreaterThanOrEqual(0);
      expect(openaiIndex).toBeGreaterThanOrEqual(0);
      expect(codexIndex).toBeGreaterThanOrEqual(0);
      expect(anthropicIndex).toBeLessThan(openrouterIndex);
      expect(openaiIndex).toBeLessThan(codexIndex);
    });
  });
  it("selects the exact provider/model pair for openrouter by index", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";
      const list = await getReplyFromConfig(
        {
          Body: "/model",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const listText = Array.isArray(list) ? list[0]?.text : list?.text;
      const lines = normalizeTestText(listText ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const targetLine = lines.find((line) =>
        line.includes("openrouter/anthropic/claude-opus-4-5"),
      );
      expect(targetLine).toBeDefined();
      const match = targetLine?.match(/^(\d+)\)/);
      expect(match?.[1]).toBeDefined();
      const index = Number.parseInt(match?.[1] ?? "", 10);
      expect(Number.isFinite(index)).toBe(true);

      const res = await getReplyFromConfig(
        {
          Body: `/model ${index}`,
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        "Model set to openrouter/anthropic/claude-opus-4-5",
      );

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openrouter");
      expect(store[sessionKey]?.modelOverride).toBe("anthropic/claude-opus-4-5");
    });
  });
  it("rejects invalid /model <#> selections", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model 99",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        'Invalid model selection "99". Use /model to list.',
      );

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });
  it("selects exact provider/model combo by index via /model <#>", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      // /model 1 should select the first item (anthropic/claude-opus-4-5)
      const res = await getReplyFromConfig(
        {
          Body: "/model 1",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      // Selecting the default model shows "reset to default" instead of "set to"
      expect(normalizeTestText(text ?? "")).toContain("anthropic/claude-opus-4-5");

      const store = loadSessionStore(cfg.session.store);
      // When selecting the default, overrides are cleared
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });
  it("selects a model by index via /model <#>", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model 3",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("Model set to openai/gpt-5.2");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-5.2");
    });
  });
});
