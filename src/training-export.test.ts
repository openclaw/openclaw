import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "./training-export.js";

const ts = 1713916800000;
const userMessage = (content: string): Context["messages"][number] => ({
  role: "user",
  content,
  timestamp: ts,
});
const assistantMessage = (content: string, model = "gpt-5"): Context["messages"][number] => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  api: "responses",
  provider: "openai",
  model,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: ts,
});
const assistantMessageWithThinking = (params: {
  thinking: string;
  reasoningId: string;
  text: string;
  model?: string;
}): Context["messages"][number] => ({
  role: "assistant",
  content: [
    {
      type: "thinking",
      thinking: params.thinking,
      thinkingSignature: JSON.stringify({ type: "reasoning", id: params.reasoningId, summary: [] }),
    },
    { type: "text", text: params.text },
  ],
  api: "responses",
  provider: "openai",
  model: params.model ?? "gpt-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: ts,
});

describe("training-export trajectory snapshot collection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "training-export-refactor-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("collects the latest compiled/completed snapshot from trajectory events", async () => {
    const trajectoryPath = path.join(tmpDir, "session.trajectory.jsonl");
    await fs.writeFile(
      trajectoryPath,
      [
        JSON.stringify({
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: "trace-1",
          source: "runtime",
          type: "context.compiled",
          ts: new Date().toISOString(),
          seq: 11,
          sessionId: "sess-1",
          runId: "run-1",
          data: {
            systemPrompt: "sys-1",
            transcriptLeafId: "leaf-1",
            messages: [userMessage("u1")],
            tools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
          },
        }),
        JSON.stringify({
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: "trace-1",
          source: "runtime",
          type: "model.completed",
          ts: new Date().toISOString(),
          seq: 12,
          sessionId: "sess-1",
          runId: "run-1",
          modelId: "gpt-5",
          data: {
            messagesSnapshot: [userMessage("u1"), assistantMessage("a1", "gpt-5")],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const events = __testing.readTrajectoryEvents({
      sessionId: "sess-1",
      sessionFile: path.join(tmpDir, "session.jsonl"),
    });
    expect(events).toHaveLength(2);

    const snapshot = __testing.collectLatestRuntimeSnapshot(
      [
        {
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: "trace-1",
          source: "runtime",
          type: "context.compiled",
          ts: new Date().toISOString(),
          seq: 11,
          sessionId: "sess-1",
          runId: "run-1",
          data: {
            systemPrompt: "sys-1",
            transcriptLeafId: "leaf-1",
            messages: [userMessage("u1")],
            tools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
          },
        },
        {
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: "trace-1",
          source: "runtime",
          type: "model.completed",
          ts: new Date().toISOString(),
          seq: 12,
          sessionId: "sess-1",
          runId: "run-1",
          modelId: "gpt-5",
          data: {
            messagesSnapshot: [userMessage("u1"), assistantMessage("a1", "gpt-5")],
          },
        },
      ],
      "sess-1",
    );

    expect(snapshot).toMatchObject({
      sessionId: "sess-1",
      runId: "run-1",
      traceId: "trace-1",
      transcriptLeafId: "leaf-1",
      systemPrompt: "sys-1",
      model: "gpt-5",
      lastContextSeq: 11,
      lastCompletedSeq: 12,
    });
    expect(snapshot?.runtimeTools).toEqual([
      { name: "exec", description: "run", parameters: { type: "object" } },
    ]);
    expect(snapshot?.runtimeMessages).toHaveLength(2);
  });
});

describe("training-export provider-owned conversion", () => {
  it("converts runtime messages through the chat_completions path", () => {
    const messages = __testing.convertRuntimeMessagesToExportMessages({
      runtimeMessages: [userMessage("u1"), assistantMessage("a1")],
      systemPrompt: "sys",
      runtimeTools: [],
    });

    expect(messages[0]).toMatchObject({ content: "sys" });
    expect(["system", "developer"]).toContain(messages[0]?.role);
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[2]).toMatchObject({ role: "assistant" });
  });

  it("exports assistant thinking blocks as reasoning_content beside content for chat_completions", () => {
    const messages = __testing.convertRuntimeMessagesToExportMessages({
      runtimeMessages: [
        userMessage("u1"),
        assistantMessageWithThinking({
          thinking: "think-1",
          reasoningId: "rs_1",
          text: "a1",
        }),
      ],
      systemPrompt: "sys",
      runtimeTools: [],
    });

    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      reasoning_content: "think-1",
      content: "a1",
    });
  });

  it("exports assistant thinking blocks as reasoning_content beside content for responses", () => {
    const messages = __testing.convertRuntimeMessagesToExportMessages({
      runtimeMessages: [
        userMessage("u1"),
        assistantMessageWithThinking({
          thinking: "think-1",
          reasoningId: "rs_1",
          text: "a1",
        }),
      ],
      systemPrompt: "sys",
      runtimeTools: [],
    });

    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      reasoning_content: "think-1",
      content: "a1",
    });
  });

  it("preserves reasoning_content for all assistant turns, not only the latest", () => {
    const messages = __testing.convertRuntimeMessagesToExportMessages({
      runtimeMessages: [
        userMessage("u1"),
        assistantMessageWithThinking({ thinking: "old", reasoningId: "rs_old", text: "a1" }),
        userMessage("u2"),
        assistantMessageWithThinking({ thinking: "new", reasoningId: "rs_new", text: "a2" }),
      ],
      runtimeTools: [],
    });

    const assistantMessages = messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toMatchObject([
      { role: "assistant", reasoning_content: "old", content: "a1" },
      { role: "assistant", reasoning_content: "new", content: "a2" },
    ]);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      reasoning_content: "new",
      content: "a2",
    });
  });

  it("converts runtime tools through the chat_completions path", () => {
    const tools = __testing.convertRuntimeToolsToExportTools([
      { name: "exec", description: "run", parameters: { type: "object" } },
    ]);

    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec",
          description: "run",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
            required: [],
          },
          strict: true,
        },
      },
    ]);
  });
});

describe("training-export episode assembly", () => {
  it("builds an episode id from trigger + trajectory snapshot", () => {
    const snapshot = {
      sessionId: "sess-1",
      runId: "run-1",
      traceId: "trace-1",
      transcriptLeafId: "leaf-1",
      systemPrompt: "sys",
      runtimeMessages: [userMessage("u1")],
      runtimeTools: [{ name: "exec", parameters: { type: "object" } }],
      lastContextSeq: 1,
      lastCompletedSeq: 2,
    };

    const id1 = __testing.buildEpisodeId({
      trigger: { kind: "trajectory_export", sessionId: "sess-1", command: "/trajectory" },
      snapshot,
    });
    const id2 = __testing.buildEpisodeId({
      trigger: { kind: "trajectory_export", sessionId: "sess-1", command: "/trajectory" },
      snapshot,
    });

    expect(id1).toBe(id2);
  });

  it("builds a train example with trajectory metadata", () => {
    const example = __testing.buildTrainExample({
      snapshot: {
        sessionId: "sess-1",
        runId: "run-1",
        traceId: "trace-1",
        transcriptLeafId: "leaf-1",
        systemPrompt: "sys",
        runtimeMessages: [userMessage("u1"), assistantMessage("a1", "gpt-5")],
        runtimeTools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
        model: "gpt-5",
        lastContextSeq: 11,
        lastCompletedSeq: 12,
      },
      trigger: { kind: "on_compaction", sessionId: "sess-1" },
    });

    expect(example?.meta).toMatchObject({
      sessionId: "sess-1",
      model: "gpt-5",
      trigger: "on_compaction",
      trajectory: {
        traceId: "trace-1",
        runId: "run-1",
        transcriptLeafId: "leaf-1",
        lastContextSeq: 11,
        lastCompletedSeq: 12,
      },
    });
    expect(example?.messages.length).toBeGreaterThan(0);
    expect(example?.tools).toHaveLength(1);
  });

  it("trims trailing non-assistant messages and still produces a valid example when a completed turn remains", () => {
    const example = __testing.buildTrainExample({
      snapshot: {
        sessionId: "sess-1",
        systemPrompt: "sys",
        runtimeMessages: [userMessage("u1"), assistantMessage("a1"), userMessage("u2")],
        runtimeTools: [],
      },
      trigger: { kind: "trajectory_export", sessionId: "sess-1" },
    });

    expect(example).toBeDefined();
  });

  it("skips task episodes without any assistant message", () => {
    const example = __testing.buildTrainExample({
      snapshot: {
        sessionId: "sess-1",
        systemPrompt: "sys",
        runtimeMessages: [userMessage("u1")],
        runtimeTools: [],
      },
      trigger: { kind: "trajectory_export", sessionId: "sess-1" },
    });

    expect(example).toBeUndefined();
  });

  it("builds before_compaction task episode as a standalone training example", () => {
    const examples = __testing.buildTrainExamplesForTrigger({
      snapshot: {
        sessionId: "sess-1",
        runId: "run-1",
        traceId: "trace-1",
        transcriptLeafId: "leaf-pre-compact",
        systemPrompt: "task system",
        runtimeMessages: [
          userMessage("task user prompt"),
          assistantMessage("task assistant reply", "gpt-5"),
        ],
        runtimeTools: [],
        model: "gpt-5",
        lastContextSeq: 11,
        lastCompletedSeq: 12,
      },
      trigger: {
        kind: "on_compaction",
        sessionId: "sess-1",
      },
    });

    expect(examples).toHaveLength(1);
    expect(examples[0]?.messages[0]).toMatchObject({ content: "task system" });
    expect(examples[0]?.messages[1]).toMatchObject({ role: "user", content: "task user prompt" });
    expect(examples[0]?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "task assistant reply",
    });
  });

  it("builds after_compaction summary episode as a standalone training example", () => {
    const examples = __testing.buildTrainExamplesForTrigger({
      snapshot: {
        sessionId: "sess-1",
        runId: "run-1",
        traceId: "trace-1",
        transcriptLeafId: "leaf-post-compact",
        systemPrompt: "task system",
        runtimeMessages: [assistantMessage("compacted session state", "gpt-5")],
        runtimeTools: [],
        model: "gpt-5",
        lastContextSeq: 21,
        lastCompletedSeq: 22,
      },
      trigger: {
        kind: "on_compaction",
        sessionId: "sess-1",
        compactionEntry: {
          summary: `## Goal
Summarized`,
          tokensBefore: 5000,
          firstKeptEntryId: "entry-5",
          fromExtension: false,
          systemPrompt: "summary system",
          promptText: `<conversation>
[User]: task user prompt

[Assistant]: task assistant reply
</conversation>

Summarize it.`,
        },
      },
    });

    expect(examples).toHaveLength(1);
    expect(examples[0]?.messages).toEqual([
      { role: "system", content: "summary system" },
      {
        role: "user",
        content: `<conversation>
[User]: task user prompt

[Assistant]: task assistant reply
</conversation>

Summarize it.`,
      },
      {
        role: "assistant",
        content: `## Goal
Summarized`,
      },
    ]);
  });
});

describe("training-export __testing compact summary train example", () => {
  it("builds a compact summary example for non-empty prompt/response", () => {
    const example = __testing.buildCompactSummaryTrainExample({
      payload: {
        sessionId: "sess-1",
        systemPrompt: "system prompt",
        promptText: `<conversation>
[User]: hello
</conversation>

Summarize it.`,
        responseText: `## Goal
Test goal`,
        model: { provider: "openai", id: "gpt-5" },
      },
    });

    expect(example).toBeDefined();
    expect(example?.messages).toEqual([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: `<conversation>
[User]: hello
</conversation>

Summarize it.`,
      },
      {
        role: "assistant",
        content: `## Goal
Test goal`,
      },
    ]);
    expect(example?.tools).toEqual([]);
    expect(example?.meta.sessionId).toBe("sess-1");
    expect(example?.meta.trigger).toBe("on_compaction");
    expect(example?.meta.model).toBe("openai/gpt-5");
  });

  it("skips compact summary export for empty conversation payload", () => {
    const example = __testing.buildCompactSummaryTrainExample({
      payload: {
        sessionId: "sess-1",
        promptText: `<conversation>

</conversation>`,
        responseText: `## Goal
Test goal`,
      },
    });
    expect(example).toBeUndefined();
  });
});
