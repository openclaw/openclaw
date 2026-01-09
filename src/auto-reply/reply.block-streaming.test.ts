import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runEmbeddedPiAgent as runEmbeddedPiAgentRunner } from "/src/agents/pi-embedded.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent as runEmbeddedPiAgentAutoReply } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "./reply.js";

vi.mock("/src/agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "clawdbot-stream-" });
}

describe("block streaming", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgentAutoReply).mockReset();
    vi.mocked(runEmbeddedPiAgentRunner).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
    ]);
  });

  async function waitForCalls(fn: () => number, calls: number) {
    const deadline = Date.now() + 1500;
    while (fn() < calls) {
      if (Date.now() > deadline) {
        throw new Error(`Expected ${calls} call(s), got ${fn()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("waits for block replies before returning final payloads", async () => {
    await withTempHome(async (home) => {
      let releaseTyping: (() => void) | undefined;
      const typingGate = new Promise<void>((resolve) => {
        releaseTyping = resolve;
      });
      const onReplyStart = vi.fn(() => typingGate);
      const onBlockReply = vi.fn().mockResolvedValue(undefined);

      const impl = async (
        params: Parameters<typeof runEmbeddedPiAgentRunner>[0],
      ) => {
        void params.onBlockReply?.({ text: "hello" });
        return {
          payloads: [{ text: "hello" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      };
      vi.mocked(runEmbeddedPiAgentAutoReply).mockImplementation(impl);
      vi.mocked(runEmbeddedPiAgentRunner).mockImplementation(impl);

      const replyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
          Provider: "discord",
        },
        {
          onReplyStart,
          onBlockReply,
          disableBlockStreaming: false,
        },
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      await waitForCalls(() => onReplyStart.mock.calls.length, 1);
      releaseTyping?.();

      const res = await replyPromise;
      expect(res).toBeUndefined();
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves block reply ordering when typing start is slow", async () => {
    await withTempHome(async (home) => {
      let releaseTyping: (() => void) | undefined;
      const typingGate = new Promise<void>((resolve) => {
        releaseTyping = resolve;
      });
      const onReplyStart = vi.fn(() => typingGate);
      const seen: string[] = [];
      const onBlockReply = vi.fn(async (payload) => {
        seen.push(payload.text ?? "");
      });

      const impl = async (
        params: Parameters<typeof runEmbeddedPiAgentRunner>[0],
      ) => {
        void params.onBlockReply?.({ text: "first" });
        void params.onBlockReply?.({ text: "second" });
        return {
          payloads: [{ text: "first" }, { text: "second" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      };
      vi.mocked(runEmbeddedPiAgentAutoReply).mockImplementation(impl);
      vi.mocked(runEmbeddedPiAgentRunner).mockImplementation(impl);

      const replyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-125",
          Provider: "telegram",
        },
        {
          onReplyStart,
          onBlockReply,
          disableBlockStreaming: false,
        },
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          telegram: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      await waitForCalls(() => onReplyStart.mock.calls.length, 1);
      releaseTyping?.();

      const res = await replyPromise;
      expect(res).toBeUndefined();
      expect(seen).toEqual(["first\n\nsecond"]);
    });
  });

  it("drops final payloads when block replies streamed", async () => {
    await withTempHome(async (home) => {
      const onBlockReply = vi.fn().mockResolvedValue(undefined);

      const impl = async (
        params: Parameters<typeof runEmbeddedPiAgentRunner>[0],
      ) => {
        void params.onBlockReply?.({ text: "chunk-1" });
        return {
          payloads: [{ text: "chunk-1\nchunk-2" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      };
      vi.mocked(runEmbeddedPiAgentAutoReply).mockImplementation(impl);
      vi.mocked(runEmbeddedPiAgentRunner).mockImplementation(impl);

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-124",
          Provider: "discord",
        },
        {
          onBlockReply,
          disableBlockStreaming: false,
        },
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      expect(res).toBeUndefined();
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to final payloads when block reply send times out", async () => {
    await withTempHome(async (home) => {
      let sawAbort = false;
      const onBlockReply = vi.fn((_, context) => {
        return new Promise<void>((resolve) => {
          context?.abortSignal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
      });

      const impl = async (
        params: Parameters<typeof runEmbeddedPiAgentRunner>[0],
      ) => {
        void params.onBlockReply?.({ text: "streamed" });
        return {
          payloads: [{ text: "final" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      };
      vi.mocked(runEmbeddedPiAgentAutoReply).mockImplementation(impl);
      vi.mocked(runEmbeddedPiAgentRunner).mockImplementation(impl);

      const replyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-126",
          Provider: "telegram",
        },
        {
          onBlockReply,
          blockReplyTimeoutMs: 10,
          disableBlockStreaming: false,
        },
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          telegram: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const res = await replyPromise;
      expect(res).toMatchObject({ text: "final" });
      expect(sawAbort).toBe(true);
    });
  });
});
