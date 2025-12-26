import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
}));

import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "./reply.js";

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(join(tmpdir(), "clawdis-triggers-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    vi.mocked(runEmbeddedPiAgent).mockClear();
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

function makeCfg(home: string) {
  return {
    agent: {
      model: "anthropic/claude-opus-4-5",
      workspace: join(home, "clawd"),
    },
    routing: {
      allowFrom: ["*"],
    },
    session: { store: join(home, "sessions.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
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

  it("restarts even with prefix/whitespace", async () => {
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
      expect(text?.startsWith("⚙️ Restarting")).toBe(true);
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
      expect(text).toContain("Status");
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
      cfg.agent = {
        ...cfg.agent,
        heartbeat: { model: "anthropic/claude-haiku-4-5-20251001" },
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

  it("updates group activation when the owner sends /activation", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation always",
          From: "[redacted-email]",
          To: "+2000",
          ChatType: "group",
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
      expect(store["group:[redacted-email]"]?.groupActivation).toBe("always");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("ignores /activation from non-owners in groups", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation mention",
          From: "[redacted-email]",
          To: "+2000",
          ChatType: "group",
          SenderE164: "+999",
        },
        {},
        cfg,
      );
      expect(res).toBeUndefined();
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
          From: "[redacted-email]",
          To: "+2000",
          ChatType: "group",
          SenderE164: "+2000",
          GroupSubject: "Test Group",
          GroupMembers: "Alice (+1), Bob (+2)",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          routing: {
            allowFrom: ["*"],
            groupChat: { requireMention: false },
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
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          routing: {
            allowFrom: ["*"],
          },
          session: {
            store: join(tmpdir(), `clawdis-session-test-${Date.now()}.json`),
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
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          routing: {
            allowFrom: ["*"],
          },
          session: {
            store: join(tmpdir(), `clawdis-session-test-${Date.now()}.json`),
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
});
