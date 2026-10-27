import path from "node:path";
import { expect, it, vi } from "vitest";
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

setupAgentRunnerTestHooks();

async function runEmptyDirectReply({
  payloads = [],
  error,
  agentEvents = [],
  config = {},
  ...opts
}: {
  payloads?: ReplyPayload[];
  error?: { kind: "tool_result_mismatch"; message: string };
  agentEvents?: Parameters<NonNullable<RunEmbeddedAgentInternalParams["onAgentEvent"]>>[0][];
  config?: OpenClawConfig;
  onBlockReply?: (payload: unknown) => Promise<void> | void;
  onAgentRunTerminalOutcome?: (outcome: "completed" | "failed") => void;
} = {}) {
  const sessionEntry = { sessionId: "session", updatedAt: Date.now(), totalTokens: 50_000 };
  runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
    for (const event of agentEvents) {
      await params.onAgentEvent?.(event);
    }
    return {
      payloads,
      meta: {
        agentMeta: { provider: "anthropic", model: "claude" },
        finalAssistantVisibleText: "",
        ...(error ? { error } : {}),
      },
    };
  });

  return createBaseRun({
    run: {
      agentId: "main",
      agentDir: path.join(rootDir, "agent"),
      config,
      reasoningLevel: "on",
    },
    reply: {
      opts,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
    },
  }).run();
}

it.each<ReplyPayload | undefined>([
  undefined,
  { text: "[[reply_to_current]]" },
  { text: "internal reasoning", isReasoning: true },
  { text: "internal commentary", isCommentary: true },
])("prepares a missing-answer fallback for non-visible output %j", async (payload) => {
  const onBlockReply = vi.fn();
  const onAgentRunTerminalOutcome = vi.fn();
  const result = await runEmptyDirectReply({
    payloads: payload ? [payload] : [],
    onBlockReply,
    onAgentRunTerminalOutcome,
    config: { channels: { whatsapp: { replyToMode: "first" } } },
  });
  expect(result).toMatchObject({
    isError: true,
    replyToId: "msg",
    text: "No answer was returned. Ask again if you still need one.",
  });
  expect(onBlockReply).not.toHaveBeenCalled();
  expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
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
