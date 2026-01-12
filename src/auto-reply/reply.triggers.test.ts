import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
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

import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  runEmbeddedPiAgent,
} from "../agents/pi-embedded.js";
import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionKey,
} from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

const MAIN_SESSION_KEY = "agent:main:main";

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
    whatsapp: {
      allowFrom: ["*"],
    },
    session: { store: join(home, "sessions.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
  it("filters usage summary to the current model provider", async () => {
    await withTempHome(async (home) => {
      usageMocks.loadProviderUsageSummary.mockClear();

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("Usage: Claude 80% left");
      expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
        expect.objectContaining({ providers: ["anthropic"] }),
      );
    });
  });

  it("aborts even with timestamp prefix", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "[Dec 5 10:00] stop",
          From: "+1000",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("handles /stop without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          From: "+1003",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("targets the active session for native /stop", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const targetSessionKey = "agent:main:telegram:group:123";
      const targetSessionId = "session-target";
      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [targetSessionKey]: {
              sessionId: targetSessionId,
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(vi.mocked(abortEmbeddedPiRun)).toHaveBeenCalledWith(
        targetSessionId,
      );
      const store = loadSessionStore(cfg.session.store);
      expect(store[targetSessionKey]?.abortedLastRun).toBe(true);
    });
  });

  it("applies native /model to the target session", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const slashSessionKey = "telegram:slash:111";
      const targetSessionKey = MAIN_SESSION_KEY;

      // Seed the target session to ensure the native command mutates it.
      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [targetSessionKey]: {
              sessionId: "session-target",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/model openai/gpt-4.1-mini",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: slashSessionKey,
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to openai/gpt-4.1-mini");

      const store = loadSessionStore(cfg.session.store);
      expect(store[targetSessionKey]?.providerOverride).toBe("openai");
      expect(store[targetSessionKey]?.modelOverride).toBe("gpt-4.1-mini");
      expect(store[slashSessionKey]).toBeUndefined();

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "hi",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
        },
        {},
        cfg,
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-4.1-mini",
        }),
      );
    });
  });

  it("shows a quick /model picker grouped by model with providers", async () => {
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
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain(
        "Pick: /model <#> or /model <provider/model>",
      );
      expect(normalized).toContain(
        "1) claude-opus-4-5 — anthropic, openrouter",
      );
      expect(normalized).toContain("3) gpt-5.2 — openai, openai-codex");
      expect(normalized).toContain("More: /model status");
      expect(normalized).not.toContain("reasoning");
      expect(normalized).not.toContain("image");
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

  it("prefers the current provider when selecting /model <#>", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "session-openrouter",
              updatedAt: Date.now(),
              providerOverride: "openrouter",
              modelOverride: "anthropic/claude-opus-4-5",
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/model 1",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
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
      expect(store[sessionKey]?.modelOverride).toBe(
        "anthropic/claude-opus-4-5",
      );
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
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        "Model set to openai/gpt-5.2",
      );

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-5.2");
    });
  });

  it("shows endpoint default in /model status when not configured", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model status",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("endpoint: default");
    });
  });

  it("includes endpoint details in /model status when configured", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        ...makeCfg(home),
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              api: "anthropic-messages",
            },
          },
        },
      };
      const res = await getReplyFromConfig(
        {
          Body: "/model status",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain(
        "[minimax] endpoint: https://api.minimax.io/anthropic api: anthropic-messages auth:",
      );
    });
  });

  it("rejects /restart by default", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "  [Dec 5] /restart",
          From: "+1001",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("/restart is disabled");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("restarts when enabled", async () => {
    await withTempHome(async (home) => {
      const cfg = { ...makeCfg(home), commands: { restart: true } };
      const res = await getReplyFromConfig(
        {
          Body: "/restart",
          From: "+1001",
          To: "+2000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(
        text?.startsWith("⚙️ Restarting") ||
          text?.startsWith("⚠️ Restart failed"),
      ).toBe(true);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("reports status without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Clawdbot");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("reports status via /usage without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Clawdbot");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("reports active auth profile and key snippet in status", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const agentDir = join(home, ".clawdbot", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        join(agentDir, "auth-profiles.json"),
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-test-1234567890abcdef",
              },
            },
            lastGood: { anthropic: "anthropic:work" },
          },
          null,
          2,
        ),
      );

      const sessionKey = resolveSessionKey("per-sender", {
        From: "+1002",
        To: "+2000",
        Provider: "whatsapp",
      } as Parameters<typeof resolveSessionKey>[1]);
      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "session-auth",
              updatedAt: Date.now(),
              authProfileOverride: "anthropic:work",
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1002",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("api-key");
      expect(text).toMatch(/…|\.{3}/);
      expect(text).toContain("(anthropic:work)");
      expect(text).not.toContain("mixed");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("strips inline /status and still runs the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      await getReplyFromConfig(
        {
          Body: "please /status now",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderE164: "+1002",
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      // Allowlisted senders: inline /status runs immediately (like /help) and is
      // stripped from the prompt; the remaining text continues through the agent.
      expect(blockReplies.length).toBe(1);
      expect(String(blockReplies[0]?.text ?? "").length).toBeGreaterThan(0);
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/status");
    });
  });

  it("handles inline /help and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "please /help now",
          From: "+1002",
          To: "+2000",
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Help");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/help");
      expect(text).toBe("ok");
    });
  });

  it("handles inline /commands and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "please /commands now",
          From: "+1002",
          To: "+2000",
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Slash commands");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/commands");
      expect(text).toBe("ok");
    });
  });

  it("handles inline /whoami and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "please /whoami now",
          From: "+1002",
          To: "+2000",
          SenderId: "12345",
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Identity");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/whoami");
      expect(text).toBe("ok");
    });
  });

  it("drops /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("drops /whoami for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };
      const res = await getReplyFromConfig(
        {
          Body: "/whoami",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("keeps inline /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };
      const res = await getReplyFromConfig(
        {
          Body: "please /status now",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      // Not allowlisted: inline /status is treated as plain text and is not stripped.
      expect(prompt).toContain("/status");
    });
  });

  it("keeps inline /help for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };
      const res = await getReplyFromConfig(
        {
          Body: "please /help now",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("/help");
    });
  });

  it("returns help without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/help",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Help");
      expect(text).toContain("Shortcuts");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("allows owner to set send policy", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/send off",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Send policy set to off");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { sendPolicy?: string }
      >;
      expect(store[MAIN_SESSION_KEY]?.sendPolicy).toBe("deny");
    });
  });

  it("allows approved sender to toggle elevated mode", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBe("on");
    });
  });

  it("rejects elevated toggles when disabled", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            enabled: false,
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("tools.elevated.enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBeUndefined();
    });
  });

  it("ignores elevated directive in groups when not mentioned", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
          groups: { "*": { requireMention: false } },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "group:123@g.us",
          To: "whatsapp:+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          ChatType: "group",
          WasMentioned: false,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(text).not.toContain("Elevated mode enabled");
    });
  });

  it("allows elevated off in groups without mention", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
          groups: { "*": { requireMention: false } },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off",
          From: "group:123@g.us",
          To: "whatsapp:+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          ChatType: "group",
          WasMentioned: false,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode disabled.");

      const store = loadSessionStore(cfg.session.store);
      expect(store["agent:main:whatsapp:group:123@g.us"]?.elevatedLevel).toBe(
        "off",
      );
    });
  });

  it("allows elevated directive in groups when mentioned", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
          groups: { "*": { requireMention: true } },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "group:123@g.us",
          To: "whatsapp:+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          ChatType: "group",
          WasMentioned: true,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store["agent:main:whatsapp:group:123@g.us"]?.elevatedLevel).toBe(
        "on",
      );
    });
  });

  it("allows elevated directive in direct chats without mentions", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBe("on");
    });
  });

  it("ignores inline elevated directive for unapproved sender", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "please /elevated on now",
          From: "+2000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).not.toContain("elevated is not available right now");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
    });
  });

  it("uses tools.elevated.allowFrom.discord for elevated approval", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: { elevated: { allowFrom: { discord: ["steipete"] } } },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "discord:123",
          To: "user:123",
          Provider: "discord",
          SenderName: "Peter Steinberger",
          SenderUsername: "steipete",
          SenderTag: "steipete",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBe("on");
    });
  });

  it("treats explicit discord elevated allowlist as override", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        tools: {
          elevated: {
            allowFrom: { discord: [] },
          },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "discord:123",
          To: "user:123",
          Provider: "discord",
          SenderName: "steipete",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("tools.elevated.allowFrom.discord");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("returns a context overflow fallback when the embedded agent throws", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockRejectedValue(
        new Error("Context window exceeded"),
      );

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "⚠️ Context overflow - conversation too long. Starting fresh might help!",
      );
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("includes the error cause when the embedded agent throws", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockRejectedValue(
        new Error("sandbox is not defined"),
      );

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "⚠️ Agent failed before reply: sandbox is not defined. Check gateway logs for details.",
      );
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("uses heartbeat model override for heartbeat runs", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = makeCfg(home);
      cfg.agents = {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          heartbeat: { model: "anthropic/claude-haiku-4-5-20251001" },
        },
      };

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        { isHeartbeat: true },
        cfg,
      );

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-haiku-4-5-20251001");
    });
  });

  it("suppresses HEARTBEAT_OK replies outside heartbeat runs", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: HEARTBEAT_TOKEN }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("strips HEARTBEAT_OK at edges outside heartbeat runs", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: `${HEARTBEAT_TOKEN} hello` }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
    });
  });

  it("updates group activation when the owner sends /activation", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation always",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Provider: "whatsapp",
          SenderE164: "+2000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Group activation set to always");
      const store = JSON.parse(
        await fs.readFile(cfg.session.store, "utf-8"),
      ) as Record<string, { groupActivation?: string }>;
      expect(store["agent:main:whatsapp:group:123@g.us"]?.groupActivation).toBe(
        "always",
      );
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("allows /activation from allowFrom in groups", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation mention",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Provider: "whatsapp",
          SenderE164: "+999",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Group activation set to mention.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("injects group activation context into the system prompt", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello group",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Provider: "whatsapp",
          SenderE164: "+2000",
          GroupSubject: "Test Group",
          GroupMembers: "Alice (+1), Bob (+2)",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["*"],
            groups: { "*": { requireMention: false } },
          },
          messages: {
            groupChat: {},
          },
          session: { store: join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extra =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.extraSystemPrompt ??
        "";
      expect(extra).toContain("Test Group");
      expect(extra).toContain("Activation: always-on");
    });
  });

  it("runs a greeting prompt for a bare /new", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "/new",
          From: "+1003",
          To: "+2000",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("A new session was started via /new or /reset");
    });
  });

  it("runs a greeting prompt for a bare /reset", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("A new session was started via /new or /reset");
    });
  });

  it("does not reset for unauthorized /reset", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: false,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["+1999"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("blocks /reset for non-owner senders", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["+1999"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("runs /compact as a gated command", async () => {
    await withTempHome(async (home) => {
      const storePath = join(
        tmpdir(),
        `clawdbot-session-test-${Date.now()}.json`,
      );
      vi.mocked(compactEmbeddedPiSession).mockResolvedValue({
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "x",
          tokensBefore: 12000,
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "/compact focus on decisions",
          From: "+1003",
          To: "+2000",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: storePath,
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text?.startsWith("⚙️ Compacted")).toBe(true);
      expect(compactEmbeddedPiSession).toHaveBeenCalledOnce();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
      const store = loadSessionStore(storePath);
      const sessionKey = resolveSessionKey("per-sender", {
        Body: "/compact focus on decisions",
        From: "+1003",
        To: "+2000",
      });
      expect(store[sessionKey]?.compactionCount).toBe(1);
    });
  });

  it("ignores think directives that only appear in the context wrapper", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: [
            "[Chat messages since your last reply - for context]",
            "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
            "",
            "[Current message - respond to this]",
            "Give me the status",
          ].join("\n"),
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("Give me the status");
      expect(prompt).not.toContain("/thinking high");
      expect(prompt).not.toContain("/think high");
    });
  });

  it("does not emit directive acks for heartbeats with /think", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "HEARTBEAT /think:high",
          From: "+1003",
          To: "+1003",
        },
        { isHeartbeat: true },
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(text).not.toMatch(/Thinking level set/i);
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it(
    "stages inbound media into the sandbox workspace",
    { timeout: 15_000 },
    async () => {
      await withTempHome(async (home) => {
        const inboundDir = join(home, ".clawdbot", "media", "inbound");
        await fs.mkdir(inboundDir, { recursive: true });
        const mediaPath = join(inboundDir, "photo.jpg");
        await fs.writeFile(mediaPath, "test");

        vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 1,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        });

        const cfg = {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
              sandbox: {
                mode: "non-main" as const,
                workspaceRoot: join(home, "sandboxes"),
              },
            },
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: join(home, "sessions.json"),
          },
        };

        const ctx = {
          Body: "hi",
          From: "group:whatsapp:demo",
          To: "+2000",
          ChatType: "group" as const,
          Provider: "whatsapp" as const,
          MediaPath: mediaPath,
          MediaType: "image/jpeg",
          MediaUrl: mediaPath,
        };

        const res = await getReplyFromConfig(ctx, {}, cfg);
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toBe("ok");
        expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();

        const prompt =
          vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
        const stagedPath = `media/inbound/${basename(mediaPath)}`;
        expect(prompt).toContain(stagedPath);
        expect(prompt).not.toContain(mediaPath);

        const sessionKey = resolveSessionKey(
          cfg.session?.scope ?? "per-sender",
          ctx,
          cfg.session?.mainKey,
        );
        const agentId = resolveAgentIdFromSessionKey(sessionKey);
        const sandbox = await ensureSandboxWorkspaceForSession({
          config: cfg,
          sessionKey,
          workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
        });
        expect(sandbox).not.toBeNull();
        if (!sandbox) {
          throw new Error("Expected sandbox to be set");
        }
        const stagedFullPath = join(
          sandbox.workspaceDir,
          "media",
          "inbound",
          basename(mediaPath),
        );
        await expect(fs.stat(stagedFullPath)).resolves.toBeTruthy();
      });
    },
  );
});

describe("group intro prompts", () => {
  const groupParticipationNote =
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.";
  it("labels Discord groups using the surface metadata", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "status update",
          From: "group:dev",
          To: "+1888",
          ChatType: "group",
          GroupSubject: "Release Squad",
          GroupMembers: "Alice, Bob",
          Provider: "discord",
        },
        {},
        makeCfg(home),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extraSystemPrompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]
          ?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toBe(
        `You are replying inside the Discord group "Release Squad". Group members: Alice, Bob. Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });

  it("keeps WhatsApp labeling for WhatsApp group chats", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "ping",
          From: "123@g.us",
          To: "+1999",
          ChatType: "group",
          GroupSubject: "Ops",
          Provider: "whatsapp",
        },
        {},
        makeCfg(home),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extraSystemPrompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]
          ?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toBe(
        `You are replying inside the WhatsApp group "Ops". Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). WhatsApp IDs: SenderId is the participant JID; [message_id: ...] is the message id for reactions (use SenderId as participant). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });

  it("labels Telegram groups using their own surface", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "ping",
          From: "group:tg",
          To: "+1777",
          ChatType: "group",
          GroupSubject: "Dev Chat",
          Provider: "telegram",
        },
        {},
        makeCfg(home),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extraSystemPrompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]
          ?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toBe(
        `You are replying inside the Telegram group "Dev Chat". Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });
});
