import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { saveSessionStore } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        OPENCLAW_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
      },
      prefix: "openclaw-rawbody-",
    },
  );
}

describe("RawBody directive parsing", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("/model, /think, /verbose directives detected from RawBody even when Body has structural wrapper", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const groupMessageCtx = {
        Body: `[Chat messages since your last reply - for context]\\n[WhatsApp ...] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp ...] Jake: /think:high\\n[from: Jake McInteer (+6421807830)]`,
        RawBody: "/think:high",
        From: "+1222",
        To: "+1222",
        ChatType: "group",
        CommandAuthorized: true,
      };

      const res = await getReplyFromConfig(
        groupMessageCtx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Thinking level set to high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("/model status detected from RawBody", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const groupMessageCtx = {
        Body: `[Context]\nJake: /model status\n[from: Jake]`,
        RawBody: "/model status",
        From: "+1222",
        To: "+1222",
        ChatType: "group",
        CommandAuthorized: true,
      };

      const res = await getReplyFromConfig(
        groupMessageCtx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
              models: {
                "anthropic/claude-opus-4-5": {},
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("CommandBody is honored when RawBody is missing", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const groupMessageCtx = {
        Body: `[Context]\nJake: /verbose on\n[from: Jake]`,
        CommandBody: "/verbose on",
        From: "+1222",
        To: "+1222",
        ChatType: "group",
        CommandAuthorized: true,
      };

      const res = await getReplyFromConfig(
        groupMessageCtx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Verbose logging enabled.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("Integration: WhatsApp group message with structural wrapper and RawBody command", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const groupMessageCtx = {
        Body: `[Chat messages since your last reply - for context]\\n[WhatsApp ...] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp ...] Jake: /status\\n[from: Jake McInteer (+6421807830)]`,
        RawBody: "/status",
        ChatType: "group",
        From: "+1222",
        To: "+1222",
        SessionKey: "agent:main:whatsapp:group:g1",
        Provider: "whatsapp",
        Surface: "whatsapp",
        SenderE164: "+1222",
        CommandAuthorized: true,
      };

      const res = await getReplyFromConfig(
        groupMessageCtx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["+1222"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Session: agent:main:whatsapp:group:g1");
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("preserves history when RawBody is provided for command parsing", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const groupMessageCtx = {
        Body: "/think:high status please",
        BodyForAgent: "/think:high status please",
        RawBody: "/think:high status please",
        InboundHistory: [{ sender: "Peter", body: "hello", timestamp: 1700000000000 }],
        From: "+1222",
        To: "+1222",
        ChatType: "group",
        GroupSubject: "Ops",
        SenderName: "Jake McInteer",
        SenderE164: "+6421807830",
        CommandAuthorized: true,
      };

      const res = await getReplyFromConfig(
        groupMessageCtx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("Chat history since last reply (untrusted, for context):");
      expect(prompt).toContain('"sender": "Peter"');
      expect(prompt).toContain('"body": "hello"');
      expect(prompt).toContain("status please");
      expect(prompt).not.toContain("/think:high");
    });
  });

  it("reuses non-default agent session files without throwing path validation errors", async () => {
    await withTempHome(async (home) => {
      const agentId = "worker1";
      const sessionId = "sess-worker-1";
      const sessionKey = `agent:${agentId}:telegram:12345`;
      const sessionsDir = path.join(home, ".openclaw", "agents", agentId, "sessions");
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      const storePath = path.join(sessionsDir, "sessions.json");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionFile, "", "utf-8");
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      });

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId, provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "telegram:12345",
          To: "telegram:12345",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.sessionFile).toBe(sessionFile);
    });
  });
});
