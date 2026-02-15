import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMock = any;
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMocks = Record<string, any>;

const piEmbeddedMocks = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

export function getAbortEmbeddedPiRunMock(): AnyMock {
  return piEmbeddedMocks.abortEmbeddedPiRun;
}

export function getCompactEmbeddedPiSessionMock(): AnyMock {
  return piEmbeddedMocks.compactEmbeddedPiSession;
}

export function getRunEmbeddedPiAgentMock(): AnyMock {
  return piEmbeddedMocks.runEmbeddedPiAgent;
}

export function getQueueEmbeddedPiMessageMock(): AnyMock {
  return piEmbeddedMocks.queueEmbeddedPiMessage;
}

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => piEmbeddedMocks.abortEmbeddedPiRun(...args),
  compactEmbeddedPiSession: (...args: unknown[]) =>
    piEmbeddedMocks.compactEmbeddedPiSession(...args),
  runEmbeddedPiAgent: (...args: unknown[]) => piEmbeddedMocks.runEmbeddedPiAgent(...args),
  queueEmbeddedPiMessage: (...args: unknown[]) => piEmbeddedMocks.queueEmbeddedPiMessage(...args),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: (...args: unknown[]) => piEmbeddedMocks.isEmbeddedPiRunActive(...args),
  isEmbeddedPiRunStreaming: (...args: unknown[]) =>
    piEmbeddedMocks.isEmbeddedPiRunStreaming(...args),
}));

const providerUsageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn().mockResolvedValue({
    updatedAt: 0,
    providers: [],
  }),
  formatUsageSummaryLine: vi.fn().mockReturnValue("📊 Usage: Claude 80% left"),
  formatUsageWindowSummary: vi.fn().mockReturnValue("Claude 80% left"),
  resolveUsageProviderId: vi.fn((provider: string) => provider.split("/")[0]),
}));

export function getProviderUsageMocks(): AnyMocks {
  return providerUsageMocks;
}

vi.mock("../infra/provider-usage.js", () => providerUsageMocks);

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

export function getModelCatalogMocks(): AnyMocks {
  return modelCatalogMocks;
}

vi.mock("../agents/model-catalog.js", () => modelCatalogMocks);

const webSessionMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

export function getWebSessionMocks(): AnyMocks {
  return webSessionMocks;
}

vi.mock("../web/session.js", () => webSessionMocks);

export const MAIN_SESSION_KEY = "agent:main:main";

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      // Avoid cross-test leakage if a test doesn't touch these mocks.
      piEmbeddedMocks.runEmbeddedPiAgent.mockClear();
      piEmbeddedMocks.abortEmbeddedPiRun.mockClear();
      piEmbeddedMocks.compactEmbeddedPiSession.mockClear();
      return await fn(home);
    },
    { prefix: "openclaw-triggers-" },
  );
}

export function makeCfg(home: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        workspace: join(home, "openclaw"),
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: { store: join(home, "sessions.json") },
  } as OpenClawConfig;
}

export async function runGreetingPromptForBareNewOrReset(params: {
  home: string;
  body: "/new" | "/reset";
  getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
}) {
  getRunEmbeddedPiAgentMock().mockResolvedValue({
    payloads: [{ text: "hello" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });

  const res = await params.getReplyFromConfig(
    {
      Body: params.body,
      From: "+1003",
      To: "+2000",
      CommandAuthorized: true,
    },
    {},
    makeCfg(params.home),
  );
  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  expect(text).toBe("hello");
  expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
  const prompt = getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]?.prompt ?? "";
  expect(prompt).toContain("A new session was started via /new or /reset");
}

export function installTriggerHandlingE2eTestHooks() {
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
