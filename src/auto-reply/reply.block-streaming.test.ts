import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { getReplyFromConfig } from "./reply.js";

type RunEmbeddedPiAgent = typeof import("../agents/pi-embedded.js").runEmbeddedPiAgent;
type RunEmbeddedPiAgentParams = Parameters<RunEmbeddedPiAgent>[0];

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

  it("waits for block replies and preserves ordering when typing start is slow", async () => {
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

      const impl = async (params: RunEmbeddedPiAgentParams) => {
        void params.onBlockReply?.({ text: "streamed" });
        return {
          payloads: [{ text: "final" }],
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
          MessageSid: "msg-126",
          Provider: "telegram",
        },
        {
          onBlockReply,
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

      const res = await replyPromise;
      expect(res).toMatchObject({ text: "final" });
      expect(sawAbort).toBe(true);
    });
  });

  it("does not enable block streaming for telegram streamMode block", async () => {
    await withTempHome(async (home) => {
      const onBlockReply = vi.fn().mockResolvedValue(undefined);

      const impl = async () => ({
        payloads: [{ text: "final" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      piEmbeddedMock.runEmbeddedPiAgent.mockImplementation(impl);

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-126",
          Provider: "telegram",
        },
        {
          onBlockReply,
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

      expect(res?.text).toBe("final");
      expect(onBlockReply).not.toHaveBeenCalled();
    });
  });
});
