import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../reply-payload.js";
import {
  rootDir,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

await import("./agent-runner-run.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent direct replies and compaction notices", () => {
  async function runEmptyDirectReply(
    options: {
      payloads?: ReplyPayload[];
      error?: { kind: "tool_result_mismatch"; message: string };
      agentEvents?: Parameters<NonNullable<RunEmbeddedAgentInternalParams["onAgentEvent"]>>[0][];
      config?: OpenClawConfig;
      onBlockReply?: (payload: unknown) => Promise<void> | void;
      onAgentRunTerminalOutcome?: (outcome: "completed" | "failed") => void;
    } = {},
  ) {
    const sessionKey = "main";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now(), totalTokens: 50_000 };
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      for (const event of options.agentEvents ?? []) {
        await params.onAgentEvent?.(event);
      }
      return {
        payloads: options.payloads ?? [],
        meta: {
          agentMeta: { provider: "anthropic", model: "claude" },
          finalAssistantVisibleText: "",
          ...(options.error ? { error: options.error } : {}),
        },
      };
    });

    return createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        config: options.config ?? {},
        reasoningLevel: "on",
      },
      reply: {
        opts: {
          onBlockReply: options.onBlockReply,
          onAgentRunTerminalOutcome: options.onAgentRunTerminalOutcome,
        },
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
      },
    }).run();
  }

  it("surfaces missing required direct replies with only a reply directive", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const result = await runEmptyDirectReply({
      payloads: [{ text: "[[reply_to_current]]" }],
      onAgentRunTerminalOutcome,
    });
    expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
    expect(result).toMatchObject({ isError: true });
  });

  it("threads the empty interactive direct fallback through normal final preparation", async () => {
    const result = await runEmptyDirectReply({
      config: { channels: { whatsapp: { replyToMode: "first" } } },
    });

    expect(result).toMatchObject({ isError: true, replyToId: "msg" });
  });

  it.each([
    ["reasoning", { text: "internal reasoning", isReasoning: true }],
    ["commentary", { text: "internal commentary", isCommentary: true }],
  ])("surfaces a fallback for disabled %s-only direct output", async (_label, payload) => {
    const onBlockReply = vi.fn();
    const result = await runEmptyDirectReply({ payloads: [payload], onBlockReply });

    expect(result).toMatchObject({
      isError: true,
      text: "No answer was returned. Ask again if you still need one.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("returns degraded warnings with direct replies without a dispatcher", async () => {
    const result = await runEmptyDirectReply({
      payloads: [{ text: "continued answer" }],
      agentEvents: [
        { stream: "compaction", data: { phase: "start" } },
        { stream: "compaction", data: { phase: "end", completed: true, qualityDegraded: true } },
      ],
    });
    expect(result).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("/new or a larger model"),
        isCompactionNotice: true,
      }),
      expect.objectContaining({ text: "continued answer" }),
    ]);
  });

  it("surfaces terminal direct failures after runtime compaction progress", async () => {
    const onBlockReply = vi.fn();
    const result = await runEmptyDirectReply({
      error: { kind: "tool_result_mismatch", message: "terminal failure after notice" },
      agentEvents: [
        { stream: "compaction", data: { phase: "start" } },
        { stream: "compaction", data: { phase: "end", completed: true } },
      ],
      config: { agents: { defaults: { compaction: { notifyUser: true } } } },
      onBlockReply,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ isError: true });
  });

  it("surfaces empty direct replies when runtime compaction notice delivery fails", async () => {
    const result = await runEmptyDirectReply({
      agentEvents: [{ stream: "compaction", data: { phase: "start" } }],
      config: { agents: { defaults: { compaction: { notifyUser: true } } } },
      onBlockReply: vi.fn().mockRejectedValue(new Error("delivery failed")),
    });

    expect(result).toMatchObject({
      isError: true,
      text: "No answer was returned. Ask again if you still need one.",
    });
  });
});
