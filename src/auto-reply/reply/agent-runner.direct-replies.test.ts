import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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
const requireRecord = createRequireRecord("record", "expected-label-object");

describe("runReplyAgent direct replies and compaction notices", () => {
  async function runEmptyDirectReply(
    agentResult: Record<string, unknown>,
    options?: {
      agentEvents?: Array<{ stream: string; data: Record<string, unknown> }>;
      config?: OpenClawConfig;
      onBlockReply?: (payload: unknown) => Promise<void> | void;
      onAgentRunTerminalOutcome?: (outcome: "completed" | "failed") => void;
    },
  ) {
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };
    const resultMeta = requireRecord(agentResult.meta, "agent result meta");
    const agentMeta = requireRecord(resultMeta.agentMeta, "agent result agent meta");
    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const onAgentEvent = requireRecord(params, "embedded agent params").onAgentEvent;
      if (typeof onAgentEvent === "function") {
        for (const event of options?.agentEvents ?? []) {
          await onAgentEvent(event);
        }
      }
      return {
        payloads: [],
        ...agentResult,
        meta: {
          ...resultMeta,
          agentMeta: {
            provider: "anthropic",
            model: "claude",
            ...agentMeta,
          },
          finalAssistantVisibleText: "",
        },
      };
    });

    return createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        config: options?.config ?? {},
        reasoningLevel: "on",
      },
      reply: {
        opts: {
          onBlockReply: options?.onBlockReply,
          onAgentRunTerminalOutcome: options?.onAgentRunTerminalOutcome,
        },
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
      },
    }).run();
  }

  it.each([
    ["without side effects", { meta: { agentMeta: {} } }],
    [
      "with only a reply directive",
      { payloads: [{ text: "[[reply_to_current]]" }], meta: { agentMeta: {} } },
    ],
    ["after hidden compaction", { meta: { agentMeta: { compactionCount: 1 } } }],
    [
      "after an intentional terminal tool batch",
      { meta: { agentMeta: {}, intentionalTerminalCompletion: "tool-batch" } },
    ],
    [
      "after a child spawn without a pending continuation",
      {
        acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:child" }],
        meta: { agentMeta: {} },
      },
    ],
  ] satisfies Array<[string, Record<string, unknown>]>)(
    "surfaces missing required direct replies %s",
    async (_label, agentResult) => {
      const onAgentRunTerminalOutcome = vi.fn();
      const result = await runEmptyDirectReply(agentResult, { onAgentRunTerminalOutcome });
      expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith("failed");
      expect(result).toMatchObject({ isError: true });
    },
  );

  it("threads the empty interactive direct fallback through normal final preparation", async () => {
    const result = await runEmptyDirectReply(
      { meta: { agentMeta: {} } },
      { config: { channels: { whatsapp: { replyToMode: "first" } } } },
    );

    expect(result).toMatchObject({ isError: true, replyToId: "msg" });
  });

  it.each([
    ["reasoning", { text: "internal reasoning", isReasoning: true }],
    ["commentary", { text: "internal commentary", isCommentary: true }],
  ])("surfaces a fallback for disabled %s-only direct output", async (_label, payload) => {
    const onBlockReply = vi.fn();
    const result = await runEmptyDirectReply(
      {
        payloads: [payload],
        meta: { agentMeta: {} },
      },
      { onBlockReply },
    );

    expect(result).toMatchObject({
      isError: true,
      text: expect.stringContaining("did not produce a visible reply"),
    });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "returns degraded warnings with direct replies without a dispatcher (failed=%s)",
    async (failed) => {
      const result = await runEmptyDirectReply(
        failed
          ? {
              meta: {
                agentMeta: {},
                error: { kind: "tool_result_mismatch", message: "terminal failure" },
              },
            }
          : { payloads: [{ text: "continued answer" }], meta: { agentMeta: {} } },
        {
          agentEvents: [
            { stream: "compaction", data: { phase: "start" } },
            {
              stream: "compaction",
              data: { phase: "end", completed: true, qualityDegraded: true },
            },
          ],
        },
      );
      expect(result).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("/new or a larger model"),
          isCompactionNotice: true,
        }),
        expect.objectContaining(failed ? { isError: true } : { text: "continued answer" }),
      ]);
    },
  );

  it("surfaces terminal direct failures after runtime compaction progress", async () => {
    const onBlockReply = vi.fn();
    const result = await runEmptyDirectReply(
      {
        meta: {
          agentMeta: {},
          error: { kind: "tool_result_mismatch", message: "terminal failure after notice" },
        },
      },
      {
        agentEvents: [
          { stream: "compaction", data: { phase: "start" } },
          { stream: "compaction", data: { phase: "end", completed: true } },
        ],
        config: {
          agents: { defaults: { compaction: { notifyUser: true } } },
        },
        onBlockReply,
      },
    );

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ isError: true });
  });

  it("surfaces empty direct replies when runtime compaction notice delivery fails", async () => {
    const result = await runEmptyDirectReply(
      { meta: { agentMeta: {} } },
      {
        agentEvents: [{ stream: "compaction", data: { phase: "start" } }],
        config: {
          agents: { defaults: { compaction: { notifyUser: true } } },
        },
        onBlockReply: vi.fn().mockRejectedValue(new Error("delivery failed")),
      },
    );

    expect(result).toMatchObject({
      isError: true,
      text: expect.stringContaining("did not produce a visible reply"),
    });
  });
});
