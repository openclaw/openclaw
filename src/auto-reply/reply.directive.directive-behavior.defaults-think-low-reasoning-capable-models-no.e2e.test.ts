import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  installDirectiveBehaviorE2EHooks,
  loadModelCatalog,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

function makeThinkConfig(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: path.join(home, "sessions.json") },
  } as const;
}

function makeWhatsAppConfig(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: path.join(home, "sessions.json") },
  } as const;
}

async function runReplyToCurrentCase(home: string, text: string) {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });

  const res = await getReplyFromConfig(
    {
      Body: "ping",
      From: "+1004",
      To: "+2000",
      MessageSid: "msg-123",
    },
    {},
    makeWhatsAppConfig(home),
  );

  return Array.isArray(res) ? res[0] : res;
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("defaults /think to low for reasoning-capable models when no default set", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeThinkConfig(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: low");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("shows off when /think has no argument and model lacks reasoning", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: false,
        },
      ]);

      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeThinkConfig(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: off");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("strips reply tags and maps reply_to_current to MessageSid", async () => {
    await withTempHome(async (home) => {
      const payload = await runReplyToCurrentCase(home, "hello [[reply_to_current]]");
      expect(payload?.text).toBe("hello");
      expect(payload?.replyToId).toBe("msg-123");
    });
  });
  it("strips reply tags with whitespace and maps reply_to_current to MessageSid", async () => {
    await withTempHome(async (home) => {
      const payload = await runReplyToCurrentCase(home, "hello [[ reply_to_current ]]");
      expect(payload?.text).toBe("hello");
      expect(payload?.replyToId).toBe("msg-123");
    });
  });
  it("prefers explicit reply_to id over reply_to_current", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [
          {
            text: "hi [[reply_to_current]] [[reply_to:abc-456]]",
          },
        ],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
        },
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

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toBe("hi");
      expect(payload?.replyToId).toBe("abc-456");
    });
  });
  it("applies inline think and still runs agent content", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "please sync /think:high now",
          From: "+1004",
          To: "+2000",
        },
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

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
});
