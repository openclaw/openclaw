import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import "../cron/isolated-agent.mocks.js";
import * as cliRunnerModule from "../agents/cli-runner.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import * as sessionsModule from "../config/sessions.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { agentCommand } from "./agent.js";

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  };
});

vi.mock("../agents/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/workspace.js")>();
  return {
    ...actual,
    ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
  };
});

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");
const runCliAgentSpy = vi.spyOn(cliRunnerModule, "runCliAgent");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  telegramOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
  agentsList?: Array<{ id: string; default?: boolean }>,
) {
  configSpy.mockReturnValue({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: { "anthropic/claude-opus-4-5": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
      list: agentsList,
    },
    session: { store: storePath, mainKey: "main" },
    channels: {
      telegram: telegramOverrides ? { ...telegramOverrides } : undefined,
    },
  });
}

async function runWithDefaultAgentConfig(params: {
  home: string;
  args: Parameters<typeof agentCommand>[0];
  agentsList?: Array<{ id: string; default?: boolean }>;
}) {
  const store = path.join(params.home, "sessions.json");
  mockConfig(params.home, store, undefined, undefined, params.agentsList);
  await agentCommand(params.args, runtime);
  return vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
}

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
}

function createTelegramOutboundPlugin() {
  return createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => {
        const sendTelegram = ctx.deps?.sendTelegram;
        if (!sendTelegram) {
          throw new Error("sendTelegram dependency missing");
        }
        const result = await sendTelegram(ctx.to, ctx.text, {
          accountId: ctx.accountId ?? undefined,
          verbose: false,
        });
        return { channel: "telegram", messageId: result.messageId, chatId: result.chatId };
      },
      sendMedia: async (ctx) => {
        const sendTelegram = ctx.deps?.sendTelegram;
        if (!sendTelegram) {
          throw new Error("sendTelegram dependency missing");
        }
        const result = await sendTelegram(ctx.to, ctx.text, {
          accountId: ctx.accountId ?? undefined,
          mediaUrl: ctx.mediaUrl,
          verbose: false,
        });
        return { channel: "telegram", messageId: result.messageId, chatId: result.chatId };
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runCliAgentSpy.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  } as never);
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
});

describe("agentCommand", () => {
  it("creates a session entry when deriving from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hello", to: "+1555" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.sessionId).toBeTruthy();
    });
  });

  it("persists thinking and verbose overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1222", thinking: "high", verbose: "on" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { thinkingLevel?: string; verboseLevel?: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.verboseLevel).toBe("on");

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("high");
      expect(callArgs?.verboseLevel).toBe("on");
    });
  });

  it("resumes when session-id is provided", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        foo: {
          sessionId: "session-123",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });
      mockConfig(home, store);

      await agentCommand({ message: "resume me", sessionId: "session-123" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionId).toBe("session-123");
    });
  });

  it("uses the resumed session agent scope when sessionId resolves to another agent store", async () => {
    await withTempHome(async (home) => {
      const storePattern = path.join(home, "sessions", "{agentId}", "sessions.json");
      const execStore = path.join(home, "sessions", "exec", "sessions.json");
      writeSessionStoreSeed(execStore, {
        "agent:exec:hook:gmail:thread-1": {
          sessionId: "session-exec-hook",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });
      mockConfig(home, storePattern, undefined, undefined, [
        { id: "dev" },
        { id: "exec", default: true },
      ]);

      await agentCommand({ message: "resume me", sessionId: "session-exec-hook" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:exec:hook:gmail:thread-1");
      expect(callArgs?.agentId).toBe("exec");
      expect(callArgs?.agentDir).toContain(`${path.sep}agents${path.sep}exec${path.sep}agent`);
    });
  });

  it("resolves resumed session transcript path from custom session store directory", async () => {
    await withTempHome(async (home) => {
      const customStoreDir = path.join(home, "custom-state");
      const store = path.join(customStoreDir, "sessions.json");
      writeSessionStoreSeed(store, {});
      mockConfig(home, store);
      const resolveSessionFilePathSpy = vi.spyOn(sessionsModule, "resolveSessionFilePath");

      await agentCommand({ message: "resume me", sessionId: "session-custom-123" }, runtime);

      const matchingCall = resolveSessionFilePathSpy.mock.calls.find(
        (call) => call[0] === "session-custom-123",
      );
      expect(matchingCall?.[2]).toEqual(
        expect.objectContaining({
          agentId: "main",
          sessionsDir: customStoreDir,
        }),
      );
    });
  });

  it("does not duplicate agent events from embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      const assistantEvents: Array<{ runId: string; text?: string }> = [];
      const stop = onAgentEvent((evt) => {
        if (evt.stream !== "assistant") {
          return;
        }
        assistantEvents.push({
          runId: evt.runId,
          text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
        });
      });

      vi.mocked(runEmbeddedPiAgent).mockImplementationOnce(async (params) => {
        const runId = (params as { runId?: string } | undefined)?.runId ?? "run";
        const data = { text: "hello", delta: "hello" };
        (
          params as {
            onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
          }
        ).onAgentEvent?.({ stream: "assistant", data });
        emitAgentEvent({ runId, stream: "assistant", data });
        return {
          payloads: [{ text: "hello" }],
          meta: { agentMeta: { provider: "p", model: "m" } },
        } as never;
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);
      stop();

      const matching = assistantEvents.filter((evt) => evt.text === "hello");
      expect(matching).toHaveLength(1);
    });
  });

  it("uses provider/model from agents.defaults.model.primary", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
        },
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-4.1-mini");
    });
  });

  it("uses default fallback list for session model overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:test": {
          sessionId: "session-subagent",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-5",
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.2"],
        },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.2": {},
        },
      });

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-opus-4-5", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedPiAgent)
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
        .mockResolvedValueOnce({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "session-subagent", provider: "openai", model: "gpt-5.2" },
          },
        });

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:test",
        },
        runtime,
      );

      const attempts = vi
        .mocked(runEmbeddedPiAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([
        { provider: "anthropic", model: "claude-opus-4-5" },
        { provider: "openai", model: "gpt-5.2" },
      ]);
    });
  });

  it("keeps stored session model override when models allowlist is empty", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:allow-any": {
          sessionId: "session-allow-any",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-custom-foo",
        },
      });

      mockConfig(home, store, {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: {},
      });

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-opus-4-5", name: "Opus", provider: "anthropic" },
      ]);

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:allow-any",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-custom-foo");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { providerOverride?: string; modelOverride?: string }
      >;
      expect(saved["agent:main:subagent:allow-any"]?.providerOverride).toBe("openai");
      expect(saved["agent:main:subagent:allow-any"]?.modelOverride).toBe("gpt-custom-foo");
    });
  });

  it("persists cleared model and auth override fields when stored override falls back to default", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:clear-overrides": {
          sessionId: "session-clear-overrides",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-5",
          authProfileOverride: "profile-legacy",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 2,
          fallbackNoticeSelectedModel: "anthropic/claude-opus-4-5",
          fallbackNoticeActiveModel: "openai/gpt-4.1-mini",
          fallbackNoticeReason: "fallback",
        },
      });

      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "openai/gpt-4.1-mini": {},
        },
      });

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-opus-4-5", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
      ]);

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:clear-overrides",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-4.1-mini");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        {
          providerOverride?: string;
          modelOverride?: string;
          authProfileOverride?: string;
          authProfileOverrideSource?: string;
          authProfileOverrideCompactionCount?: number;
          fallbackNoticeSelectedModel?: string;
          fallbackNoticeActiveModel?: string;
          fallbackNoticeReason?: string;
        }
      >;
      const entry = saved["agent:main:subagent:clear-overrides"];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(entry?.authProfileOverride).toBeUndefined();
      expect(entry?.authProfileOverrideSource).toBeUndefined();
      expect(entry?.authProfileOverrideCompactionCount).toBeUndefined();
      expect(entry?.fallbackNoticeSelectedModel).toBeUndefined();
      expect(entry?.fallbackNoticeActiveModel).toBeUndefined();
      expect(entry?.fallbackNoticeReason).toBeUndefined();
    });
  });

  it("keeps explicit sessionKey even when sessionId exists elsewhere", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          sessionId: "sess-main",
          sessionKey: "agent:main:subagent:abc",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:main:subagent:abc");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(saved["agent:main:subagent:abc"]?.sessionId).toBe("sess-main");
    });
  });

  it("persists resolved sessionFile for existing session keys", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:abc": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:abc",
        },
        runtime,
      );

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId?: string; sessionFile?: string }
      >;
      const entry = saved["agent:main:subagent:abc"];
      expect(entry?.sessionId).toBe("sess-main");
      expect(entry?.sessionFile).toContain(
        `${path.sep}agents${path.sep}main${path.sep}sessions${path.sep}sess-main.jsonl`,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionFile).toBe(entry?.sessionFile);
    });
  });

  it("preserves topic transcript suffix when persisting missing sessionFile", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:telegram:group:123:topic:456": {
          sessionId: "sess-topic",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:telegram:group:123:topic:456",
        },
        runtime,
      );

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId?: string; sessionFile?: string }
      >;
      const entry = saved["agent:main:telegram:group:123:topic:456"];
      expect(entry?.sessionId).toBe("sess-topic");
      expect(entry?.sessionFile).toContain("sess-topic-topic-456.jsonl");

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionFile).toBe(entry?.sessionFile);
    });
  });

  it("derives session key from --agent when no routing target is provided", async () => {
    await withTempHome(async (home) => {
      const callArgs = await runWithDefaultAgentConfig({
        home,
        args: { message: "hi", agentId: "ops" },
        agentsList: [{ id: "ops" }],
      });
      expect(callArgs?.sessionKey).toBe("agent:ops:main");
      expect(callArgs?.sessionFile).toContain(`${path.sep}agents${path.sep}ops${path.sep}sessions`);
    });
  });

  it("rejects unknown agent overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await expect(agentCommand({ message: "hi", agentId: "ghost" }, runtime)).rejects.toThrow(
        'Unknown agent id "ghost"',
      );
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });

  it("prints JSON payload when requested", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
        meta: {
          durationMs: 42,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1999", json: true }, runtime);

      const logged = (runtime.log as unknown as MockInstance).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(logged) as {
        payloads: Array<{ text: string; mediaUrl?: string | null }>;
        meta: { durationMs: number };
      };
      expect(parsed.payloads[0].text).toBe("json-reply");
      expect(parsed.payloads[0].mediaUrl).toBe("http://x.test/a.jpg");
      expect(parsed.meta.durationMs).toBe(42);
    });
  });

  it("passes the message through as the agent prompt", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "ping", to: "+1333" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.prompt).toBe("ping");
    });
  });

  it("passes through telegram accountId when delivering", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, { botToken: "t-1" });
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "telegram", plugin: createTelegramOutboundPlugin(), source: "test" },
        ]),
      );
      const deps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "123" }),
        sendMessageSlack: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "";
      try {
        await agentCommand(
          {
            message: "hi",
            to: "123",
            deliver: true,
            channel: "telegram",
          },
          runtime,
          deps,
        );

        expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
          "123",
          "ok",
          expect.objectContaining({ accountId: undefined, verbose: false }),
        );
      } finally {
        if (prevTelegramToken === undefined) {
          delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
          process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
        }
      }
    });
  });

  it("uses reply channel as the message channel context", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops", replyChannel: "slack" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.messageChannel).toBe("slack");
    });
  });

  it("prefers runContext for embedded routing", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          to: "+1555",
          channel: "whatsapp",
          runContext: { messageChannel: "slack", accountId: "acct-2" },
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.messageChannel).toBe("slack");
      expect(callArgs?.agentAccountId).toBe("acct-2");
    });
  });

  it("forwards accountId to embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1555", accountId: "kev" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.agentAccountId).toBe("kev");
    });
  });

  it("logs output when delivery is disabled", async () => {
    await withTempHome(async (home) => {
      await runWithDefaultAgentConfig({
        home,
        args: { message: "hi", agentId: "ops" },
        agentsList: [{ id: "ops" }],
      });

      expect(runtime.log).toHaveBeenCalledWith("ok");
    });
  });
});
