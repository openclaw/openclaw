import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerAgentRunContext,
  resetAgentRunContextForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { createAgentEventChannelMirror } from "./agent-event-channel-mirror.js";

function event(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-1",
    seq: 1,
    stream: "assistant",
    ts: 1_000,
    sessionKey: "agent:main:subagent:child-1",
    data: {},
    ...overrides,
  } as AgentEventPayload;
}

function createHarness(options?: { telegramConfig?: Record<string, unknown> }) {
  const sendDurableMessageBatch = vi.fn().mockResolvedValue({
    status: "sent",
    results: [{ channel: "telegram", messageId: "tg-1", chatId: "-100" }],
    receipt: { id: "receipt-1" },
  });
  const sendProgressPreview = vi.fn().mockResolvedValue({ messageId: "preview-1" });
  const editProgressPreview = vi.fn().mockResolvedValue(undefined);
  const deleteProgressPreview = vi.fn().mockResolvedValue(undefined);
  const loadSessionEntry = vi.fn().mockReturnValue({
    cfg: {
      channels: {
        telegram: options?.telegramConfig ?? {
          streaming: { mode: "progress", progress: { label: false, maxLines: 8 } },
        },
      },
    },
    entry: {
      sessionId: "session-1",
      agentId: "main",
      deliveryContext: {
        channel: "telegram",
        to: "-100",
        accountId: "default",
        threadId: "1189",
      },
    },
  });
  const mirror = createAgentEventChannelMirror({
    sendDurableMessageBatch,
    loadSessionEntry,
    sendProgressPreview,
    editProgressPreview,
    deleteProgressPreview,
    delayMs: 0,
  } as any);
  return {
    mirror,
    sendDurableMessageBatch,
    sendProgressPreview,
    editProgressPreview,
    deleteProgressPreview,
    loadSessionEntry,
  };
}

describe("agent event channel mirror", () => {
  afterEach(() => {
    resetAgentRunContextForTest();
  });

  it("updates one thread progress preview instead of appending durable messages for each mirrored event", async () => {
    const { mirror, sendDurableMessageBatch, sendProgressPreview, editProgressPreview } =
      createHarness();

    await mirror(
      event({
        stream: "assistant",
        data: { text: "Step 1: inspect", delta: "Step 1: inspect", phase: "commentary" },
      }),
    );
    await mirror(
      event({
        seq: 2,
        stream: "item",
        data: { itemId: "tool-1", phase: "start", kind: "tool", title: "exec cargo fmt" },
      }),
    );
    await mirror(
      event({
        seq: 3,
        stream: "command_output",
        data: {
          itemId: "tool-1-output",
          phase: "end",
          title: "exec cargo fmt",
          name: "exec",
          output: "fmt passed",
          exitCode: 0,
        },
      }),
    );
    await mirror(
      event({
        seq: 4,
        stream: "thinking",
        data: { text: "checking blockers", delta: "checking blockers" },
      }),
    );

    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(sendProgressPreview).toHaveBeenCalledTimes(1);
    expect(sendProgressPreview.mock.calls[0]?.[0]).toMatchObject({
      cfg: { channels: { telegram: expect.any(Object) } },
      to: "-100",
      accountId: "default",
      threadId: "1189",
      text: expect.stringContaining("Step 1: inspect"),
    });
    expect(editProgressPreview).toHaveBeenCalledTimes(3);
    const editedTexts = editProgressPreview.mock.calls.map((call) => call[0].text).join("\n---\n");
    expect(editedTexts).toContain("exec cargo fmt");
    expect(editedTexts).toContain("completed");
    expect(editedTexts).toContain("checking blockers");
  });

  it("skips final-answer assistant text because normal agent delivery already sends it", async () => {
    const { mirror, sendProgressPreview } = createHarness();

    await mirror(
      event({
        data: {
          text: "Final review summary",
          delta: "Final review summary",
          phase: "final_answer",
        },
      }),
    );

    expect(sendProgressPreview).not.toHaveBeenCalled();
  });

  it("resolves hidden cron run session keys from agent run context", async () => {
    const { mirror, sendProgressPreview } = createHarness();
    registerAgentRunContext("run-hidden-cron", {
      sessionKey: "agent:main:cron:job-1:run:run-hidden-cron",
      isControlUiVisible: false,
    });

    await mirror(
      event({
        runId: "run-hidden-cron",
        sessionKey: undefined,
        data: { text: "hidden cron progress", delta: "hidden cron progress" },
      }),
    );

    expect(sendProgressPreview).toHaveBeenCalledTimes(1);
    expect(sendProgressPreview.mock.calls[0]?.[0]).toMatchObject({
      threadId: "1189",
      text: "💬 hidden cron progress",
    });
  });

  it("mirrors any session with an explicit Telegram thread route, including cron proof sessions", async () => {
    const { mirror, sendProgressPreview } = createHarness();

    await mirror(
      event({
        sessionKey: "agent:main:cron:job-1:run:run-1",
        data: { text: "cron threaded progress", delta: "cron threaded progress" },
      }),
    );

    expect(sendProgressPreview).toHaveBeenCalledTimes(1);
    expect(sendProgressPreview.mock.calls[0]?.[0]).toMatchObject({
      to: "-100",
      threadId: "1189",
      text: "💬 cron threaded progress",
    });
  });

  it("bounds progress preview lines and deletes the preview when the run ends", async () => {
    const { mirror, sendProgressPreview, editProgressPreview, deleteProgressPreview } =
      createHarness({
        telegramConfig: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 3 } },
        },
      });

    await mirror(event({ data: { text: "first", delta: "first" } }));
    await mirror(event({ seq: 2, stream: "thinking", data: { text: "second", delta: "second" } }));
    await mirror(event({ seq: 3, stream: "assistant", data: { text: "third", delta: "third" } }));
    await mirror(event({ seq: 4, stream: "assistant", data: { text: "fourth", delta: "fourth" } }));

    const latestPreviewText = editProgressPreview.mock.calls.at(-1)?.[0].text;
    expect(latestPreviewText).not.toContain("first");
    expect(latestPreviewText).toContain("second");
    expect(latestPreviewText).toContain("third");
    expect(latestPreviewText).toContain("fourth");

    await mirror(event({ seq: 5, stream: "lifecycle", data: { phase: "end" } }));
    expect(deleteProgressPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "-100",
        threadId: "1189",
        messageId: "preview-1",
      }),
    );

    await mirror(event({ seq: 6, runId: "run-2", data: { text: "new run", delta: "new run" } }));
    expect(sendProgressPreview).toHaveBeenCalledTimes(2);
  });

  it("does not mirror sessions without a Telegram thread route", async () => {
    const { sendProgressPreview, sendDurableMessageBatch, loadSessionEntry } = createHarness();
    loadSessionEntry.mockReturnValue({
      cfg: { channels: {} },
      entry: {
        sessionId: "session-1",
        deliveryContext: { channel: "telegram", to: "-100", accountId: "default" },
      },
    });
    const mirror = createAgentEventChannelMirror({
      sendDurableMessageBatch,
      loadSessionEntry,
      sendProgressPreview,
      delayMs: 0,
    } as any);

    await mirror(
      event({
        sessionKey: "agent:main:explicit:abc",
        data: { text: "no thread", delta: "no thread" },
      }),
    );

    expect(sendProgressPreview).not.toHaveBeenCalled();
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  });
});
