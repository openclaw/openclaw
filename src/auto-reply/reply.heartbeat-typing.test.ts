import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

import { getReplyFromConfig } from "./reply.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      runEmbeddedPiAgentMock.mockClear();
      return await fn(home);
    },
    { prefix: "openclaw-typing-" },
  );
}

function makeCfg(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: join(home, "openclaw"),
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: { store: join(home, "sessions.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getReplyFromConfig typing (heartbeat)", () => {
  it("starts typing for normal runs", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "ok" }],
        meta: {},
      });
      const onReplyStart = vi.fn();

      await getReplyFromConfig(
        { Body: "hi", From: "+1000", To: "+2000", Provider: "whatsapp" },
        { onReplyStart, isHeartbeat: false },
        makeCfg(home),
      );

      expect(onReplyStart).toHaveBeenCalled();
    });
  });

  it("does not start typing for heartbeat runs", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "ok" }],
        meta: {},
      });
      const onReplyStart = vi.fn();

      await getReplyFromConfig(
        { Body: "hi", From: "+1000", To: "+2000", Provider: "whatsapp" },
        { onReplyStart, isHeartbeat: true },
        makeCfg(home),
      );

      expect(onReplyStart).not.toHaveBeenCalled();
    });
  });

  it("uses heartbeatModel option over global defaults", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "HEARTBEAT_OK" }],
        meta: {},
      });

      const cfg = {
        ...makeCfg(home),
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "openclaw"),
            heartbeat: {
              model: "anthropic/claude-haiku-4-5", // Global default heartbeat model
            },
          },
        },
      };

      await getReplyFromConfig(
        { Body: "hi", From: "+1000", To: "+2000", Provider: "heartbeat" },
        {
          isHeartbeat: true,
          heartbeatModel: "ollama/qwen2.5:3b", // Per-agent override
        },
        cfg,
      );

      // The heartbeatModel option should override the global heartbeat.model
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const callParams = runEmbeddedPiAgentMock.mock.calls[0][0];
      expect(callParams.provider).toBe("ollama");
      expect(callParams.model).toBe("qwen2.5:3b");
    });
  });

  it("falls back to global heartbeat.model when heartbeatModel option is not provided", async () => {
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "HEARTBEAT_OK" }],
        meta: {},
      });

      const cfg = {
        ...makeCfg(home),
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "openclaw"),
            heartbeat: {
              model: "openai/gpt-4.1-mini", // Global default heartbeat model
            },
          },
        },
      };

      await getReplyFromConfig(
        { Body: "hi", From: "+1000", To: "+2000", Provider: "heartbeat" },
        { isHeartbeat: true }, // No heartbeatModel option
        cfg,
      );

      // Should use global heartbeat.model
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const callParams = runEmbeddedPiAgentMock.mock.calls[0][0];
      expect(callParams.provider).toBe("openai");
      expect(callParams.model).toBe("gpt-4.1-mini");
    });
  });
});
