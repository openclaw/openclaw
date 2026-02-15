import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { MEMORY_FLUSH_CHECKPOINT_TEXT } from "./memory-flush.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
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

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

describe("runMemoryFlushIfNeeded", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
  });

  it("emits a checkpoint block reply before running pre-compaction flush", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });

    await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 5_000,
              memoryFlush: {
                enabled: true,
                softThresholdTokens: 2_000,
              },
            },
          },
        },
      },
      followupRun: {
        prompt: "hello",
        enqueuedAt: Date.now(),
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {
            agents: {
              defaults: {
                compaction: {
                  reserveTokensFloor: 5_000,
                  memoryFlush: {
                    enabled: true,
                    softThresholdTokens: 2_000,
                  },
                },
              },
            },
          },
          provider: "anthropic",
          model: "test-model",
          timeoutMs: 1_000,
          blockReplyBreak: "text_end",
        },
      } as unknown as FollowupRun,
      sessionCtx: {} as TemplateContext,
      opts: { onBlockReply },
      defaultModel: "test-model",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry: { totalTokens: 96_000, compactionCount: 0 },
      isHeartbeat: false,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith({ text: MEMORY_FLUSH_CHECKPOINT_TEXT });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.invocationCallOrder[0]).toBeLessThan(
      runEmbeddedPiAgentMock.mock.invocationCallOrder[0],
    );
  });

  it("does not emit checkpoint when memory flush threshold is not met", async () => {
    const onBlockReply = vi.fn(async () => {});

    await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 5_000,
              memoryFlush: {
                enabled: true,
                softThresholdTokens: 2_000,
              },
            },
          },
        },
      },
      followupRun: {
        prompt: "hello",
        enqueuedAt: Date.now(),
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {
            agents: {
              defaults: {
                compaction: {
                  reserveTokensFloor: 5_000,
                  memoryFlush: {
                    enabled: true,
                    softThresholdTokens: 2_000,
                  },
                },
              },
            },
          },
          provider: "anthropic",
          model: "test-model",
          timeoutMs: 1_000,
          blockReplyBreak: "text_end",
        },
      } as unknown as FollowupRun,
      sessionCtx: {} as TemplateContext,
      opts: { onBlockReply },
      defaultModel: "test-model",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry: { totalTokens: 20_000, compactionCount: 0 },
      isHeartbeat: false,
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
