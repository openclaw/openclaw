import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { getReplyFromConfig } from "./reply.js";

type RunEmbeddedPiAgent = typeof import("../agents/pi-embedded.js").runEmbeddedPiAgent;
type RunEmbeddedPiAgentParams = Parameters<RunEmbeddedPiAgent>[0];
type ReplyResult = Awaited<ReturnType<RunEmbeddedPiAgent>>;

const piEmbeddedMock = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn<ReturnType<RunEmbeddedPiAgent>, Parameters<RunEmbeddedPiAgent>>(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("/src/agents/pi-embedded.js", () => piEmbeddedMock);
vi.mock("../agents/pi-embedded.js", () => piEmbeddedMock);
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

type HomeEnvSnapshot = {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  HOMEDRIVE: string | undefined;
  HOMEPATH: string | undefined;
  OPENCLAW_STATE_DIR: string | undefined;
};

function snapshotHomeEnv(): HomeEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreHomeEnv(snapshot: HomeEnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

let fixtureRoot = "";
let caseId = 0;

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = path.join(fixtureRoot, `case-${++caseId}`);
  await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  const envSnapshot = snapshotHomeEnv();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");

  if (process.platform === "win32") {
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      process.env.HOMEDRIVE = match[1];
      process.env.HOMEPATH = match[2] || "\\";
    }
  }

  try {
    return await fn(home);
  } finally {
    restoreHomeEnv(envSnapshot);
  }
}

function makeAgentResult(text: string): ReplyResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

describe("block streaming", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stream-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    piEmbeddedMock.abortEmbeddedPiRun.mockReset().mockReturnValue(false);
    piEmbeddedMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    piEmbeddedMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    piEmbeddedMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    piEmbeddedMock.runEmbeddedPiAgent.mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
    ]);
  });

  it("handles ordering, timeout fallback, and telegram streamMode block", async () => {
    await withTempHome(async (home) => {
      let releaseTyping: (() => void) | undefined;
      const typingGate = new Promise<void>((resolve) => {
        releaseTyping = resolve;
      });
      let resolveOnReplyStart: (() => void) | undefined;
      const onReplyStartCalled = new Promise<void>((resolve) => {
        resolveOnReplyStart = resolve;
      });
      const onReplyStart = vi.fn(() => {
        resolveOnReplyStart?.();
        return typingGate;
      });
      const seen: string[] = [];
      const onBlockReply = vi.fn(async (payload) => {
        seen.push(payload.text ?? "");
      });

      const impl = async (params: RunEmbeddedPiAgentParams) => {
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
      piEmbeddedMock.runEmbeddedPiAgent.mockImplementation(impl);

      const replyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
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
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      await onReplyStartCalled;
      releaseTyping?.();

      const res = await replyPromise;
      expect(res).toBeUndefined();
      expect(seen).toEqual(["first\n\nsecond"]);

      let sawAbort = false;
      const onBlockReplyTimeout = vi.fn((_, context) => {
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

      const timeoutImpl = async (params: RunEmbeddedPiAgentParams) => {
        void params.onBlockReply?.({ text: "streamed" });
        return {
          payloads: [{ text: "final" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      };
      piEmbeddedMock.runEmbeddedPiAgent.mockImplementation(timeoutImpl);

      const timeoutReplyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-126",
          Provider: "telegram",
        },
        {
          onBlockReply: onBlockReplyTimeout,
          blockReplyTimeoutMs: 1,
          disableBlockStreaming: false,
        },
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const timeoutRes = await timeoutReplyPromise;
      expect(timeoutRes).toMatchObject({ text: "final" });
      expect(sawAbort).toBe(true);

      const onBlockReplyStreamMode = vi.fn().mockResolvedValue(undefined);
      piEmbeddedMock.runEmbeddedPiAgent.mockImplementation(async () => ({
        payloads: [{ text: "final" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      }));

      const resStreamMode = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-127",
          Provider: "telegram",
        },
        {
          onBlockReply: onBlockReplyStreamMode,
        },
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { telegram: { allowFrom: ["*"], streamMode: "block" } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      expect(resStreamMode?.text).toBe("final");
      expect(onBlockReplyStreamMode).not.toHaveBeenCalled();
    });
  });

  it("queues followups for collect + summarize modes", async () => {
    vi.useFakeTimers();
    await withTempHomeBase(
      async (home) => {
        const prompts: string[] = [];
        piEmbeddedMock.runEmbeddedPiAgent.mockImplementation(async (params) => {
          prompts.push(params.prompt);
          return makeAgentResult("ok");
        });

        const collectCfg = {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
          messages: {
            queue: {
              mode: "collect",
              debounceMs: 200,
              cap: 10,
              drop: "summarize",
            },
          },
        };

        piEmbeddedMock.isEmbeddedPiRunActive.mockReturnValue(true);
        piEmbeddedMock.isEmbeddedPiRunStreaming.mockReturnValue(true);

        const first = await getReplyFromConfig(
          { Body: "first", From: "+1001", To: "+2000", MessageSid: "m-1" },
          {},
          collectCfg,
        );
        expect(first).toBeUndefined();
        expect(piEmbeddedMock.runEmbeddedPiAgent).not.toHaveBeenCalled();

        piEmbeddedMock.isEmbeddedPiRunActive.mockReturnValue(false);
        piEmbeddedMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

        const second = await getReplyFromConfig(
          { Body: "second", From: "+1001", To: "+2000" },
          {},
          collectCfg,
        );
        const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
        expect(secondText).toBe("ok");

        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        const queuedPrompt =
          prompts.find((p) => p.includes("[Queued messages while agent was busy]")) ?? "";
        expect(queuedPrompt).toContain("Queued #1");
        expect(queuedPrompt).toContain("first");
        expect(queuedPrompt).not.toContain("[message_id:");

        prompts.length = 0;
        piEmbeddedMock.isEmbeddedPiRunActive.mockReturnValue(true);
        piEmbeddedMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

        const followupCfg = {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions-2.json") },
          messages: {
            queue: {
              mode: "followup",
              debounceMs: 0,
              cap: 1,
              drop: "summarize",
            },
          },
        };

        await getReplyFromConfig({ Body: "one", From: "+1002", To: "+2000" }, {}, followupCfg);
        await getReplyFromConfig({ Body: "two", From: "+1002", To: "+2000" }, {}, followupCfg);

        piEmbeddedMock.isEmbeddedPiRunActive.mockReturnValue(false);
        await getReplyFromConfig({ Body: "three", From: "+1002", To: "+2000" }, {}, followupCfg);

        await vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
        expect(prompts.some((p) => p.includes("[Queue overflow]"))).toBe(true);
      },
      { prefix: "openclaw-queue-" },
    );
  });
});
