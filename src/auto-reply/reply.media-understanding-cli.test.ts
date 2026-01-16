import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { formatMediaUnderstandingBody } from "../media-understanding/format.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async ({ ctx }: { ctx: { Body?: string } }) => {
    if (ctx) {
      ctx.Body = "[Video]\nDescription:\nvideo desc";
      (ctx as Record<string, unknown>).MediaUnderstanding = [
        {
          kind: "video.description",
          attachmentIndex: 1,
          text: "video desc",
          provider: "google",
        },
      ];
      (ctx as Record<string, unknown>).CommandBody = "caption text";
      (ctx as Record<string, unknown>).RawBody = "caption text";
    }
    return {
      outputs: [
        {
          kind: "video.description",
          attachmentIndex: 1,
          text: "video desc",
          provider: "google",
        },
      ],
      appliedAudio: false,
      appliedVideo: true,
    };
  }),
  transcribeInboundAudio: vi.fn(async () => ({ text: "cli transcript" })),
  runEmbeddedPiAgent: vi.fn(),
  runPreparedReply: vi.fn(async () => undefined),
}));

vi.mock("../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));

vi.mock("./transcription.js", async () => {
  const actual = await vi.importActual<typeof import("./transcription.js")>(
    "./transcription.js",
  );
  return {
    ...actual,
    transcribeInboundAudio: mocks.transcribeInboundAudio,
  };
});

vi.mock("./agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: mocks.runEmbeddedPiAgent,
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("./reply/get-reply-run.js", () => ({
  runPreparedReply: mocks.runPreparedReply,
}));

const { getReplyFromConfig } = await import("./reply.js");

function makeResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      mocks.runEmbeddedPiAgent.mockReset();
      return await fn(home);
    },
    {
      env: {
        CLAWDBOT_BUNDLED_SKILLS_DIR: (home) => path.join(home, "bundled-skills"),
      },
      prefix: "clawdbot-media-understanding-cli-",
    },
  );
}

function makeCfg(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "clawd"),
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: path.join(home, "sessions.json") },
    tools: {
      audio: {
        transcription: {
          args: ["--model", "base", "{{MediaPath}}"],
        },
      },
    },
  };
}

describe("CLI transcription + media understanding", () => {
  it("rebuilds Body when CLI transcript follows video understanding", async () => {
    await withTempHome(async (home) => {
      mocks.runEmbeddedPiAgent.mockImplementation(async () => makeResult("ok"));

      const ctx = {
        Body: "<media:video> caption text",
        From: "+1001",
        To: "+2000",
        MediaPaths: ["note.ogg", "clip.mp4"],
      };
      const cfg = makeCfg(home);

      await getReplyFromConfig(ctx, {}, cfg);

      const outputs = (ctx as Record<string, unknown>).MediaUnderstanding as Array<{
        kind: "audio.transcription" | "video.description";
        attachmentIndex: number;
        text: string;
        provider: string;
      }>;
      expect(outputs).toHaveLength(2);
      expect(outputs.some((output) => output.kind === "audio.transcription")).toBe(true);
      expect((ctx as Record<string, unknown>).CommandBody).toBe("cli transcript");
      expect((ctx as Record<string, unknown>).RawBody).toBe("cli transcript");
      expect((ctx as Record<string, unknown>).Body).toBe(
        formatMediaUnderstandingBody({
          body: "caption text",
          outputs,
        }),
      );
    });
  });

  it("skips CLI transcription when scope denies", async () => {
    await withTempHome(async (home) => {
      mocks.runEmbeddedPiAgent.mockImplementation(async () => makeResult("ok"));
      mocks.transcribeInboundAudio.mockClear();

      const ctx = {
        Body: "<media:video> caption text",
        From: "+1001",
        To: "+2000",
        MediaPaths: ["note.ogg", "clip.mp4"],
        Surface: "whatsapp",
      };
      const cfg = makeCfg(home);
      cfg.tools.audio.transcription.scope = { default: "deny" };

      await getReplyFromConfig(ctx, {}, cfg);

      const outputs = (ctx as Record<string, unknown>).MediaUnderstanding as Array<{
        kind: "video.description";
        attachmentIndex: number;
        text: string;
        provider: string;
      }>;
      expect(outputs).toHaveLength(1);
      expect(mocks.transcribeInboundAudio).not.toHaveBeenCalled();
      expect((ctx as Record<string, unknown>).CommandBody).toBe("caption text");
      expect((ctx as Record<string, unknown>).RawBody).toBe("caption text");
      expect((ctx as Record<string, unknown>).Body).toBe("[Video]\nDescription:\nvideo desc");
    });
  });
});
