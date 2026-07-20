import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createStatusFooterConversationKey,
  decorateIntermediate,
  finalize,
  noteActivity,
  resolveStatusFooterMode,
  STATUS_FOOTER_MAX_RENDERED_CHARS,
} from "./status-footer.js";
import {
  finalizeStatusFooterRun,
  noteStatusFooterRunStarted,
  resetStatusFooterStateForTest,
} from "./status-footer.test-support.js";

type SentMessage = { id: string; text: string };

function createTransport() {
  const messages = new Map<string, string>();
  let nextId = 0;
  const send = vi.fn(async (text: string): Promise<SentMessage> => {
    const id = String(++nextId);
    messages.set(id, text);
    return { id, text };
  });
  const edit = vi.fn(async (id: string, text: string) => {
    messages.set(id, text);
  });
  return { messages, send, edit };
}

async function sendIntermediate(params: {
  transport: ReturnType<typeof createTransport>;
  mode?: "off" | "minimal" | "activity";
  text: string;
  runId?: string;
  now?: number;
}) {
  return await decorateIntermediate({
    conversationKey: "telegram:chat-1",
    mode: params.mode ?? "activity",
    runId: params.runId,
    textWithoutFooter: params.text,
    send: params.transport.send,
    getMessageId: (result) => result.id,
    edit: params.transport.edit,
    now: () => params.now ?? 120_000,
  });
}

describe("status footer", () => {
  beforeEach(() => resetStatusFooterStateForTest());

  it("records only after an intermediate send succeeds", async () => {
    const transport = createTransport();
    transport.send.mockRejectedValueOnce(new Error("send failed"));

    await expect(sendIntermediate({ transport, text: "first" })).rejects.toThrow("send failed");
    await finalize("telegram:chat-1");
    expect(transport.edit).not.toHaveBeenCalled();

    const sent = await sendIntermediate({ transport, text: "second" });
    expect(sent.text).toBe("second\n\n▸ Working · 0s · reply to steer");
  });

  it("relocates the footer to the newest intermediate", async () => {
    const transport = createTransport();
    const first = await sendIntermediate({ transport, text: "first" });
    const second = await sendIntermediate({ transport, text: "second" });

    expect(transport.messages.get(first.id)).toBe("first");
    expect(transport.messages.get(second.id)).toContain("second\n\n▸ Working");
    expect(transport.edit).toHaveBeenCalledWith(first.id, "first");
  });

  it("strips on final delivery, cancel, and error cleanup", async () => {
    const transport = createTransport();
    const finalSend = vi.fn(async (text: string) => text);
    const runId = "run-1";
    noteStatusFooterRunStarted(runId, 60_000);
    const sent = await sendIntermediate({ transport, text: "intermediate", runId });

    await finalize("telegram:chat-1", runId);
    await finalSend("final");
    expect(transport.messages.get(sent.id)).toBe("intermediate");
    expect(finalSend).toHaveBeenCalledWith("final");

    const cancelled = await sendIntermediate({ transport, text: "cancel", runId });
    await finalizeStatusFooterRun(runId);
    expect(transport.messages.get(cancelled.id)).toBe("cancel");

    const errorRun = "run-error";
    const errored = await sendIntermediate({ transport, text: "error", runId: errorRun });
    await finalizeStatusFooterRun(errorRun);
    expect(transport.messages.get(errored.id)).toBe("error");
  });

  it("renders off, minimal, activity, and activity fallback modes", async () => {
    const transport = createTransport();
    noteStatusFooterRunStarted("run-1", 0);
    noteActivity(
      "telegram:chat-1",
      "Running a very long test suite with many extra words here",
      "run-1",
    );

    const off = await sendIntermediate({ transport, mode: "off", text: "off", runId: "run-1" });
    expect(off.text).toBe("off");
    expect(transport.edit).not.toHaveBeenCalled();

    const minimal = await sendIntermediate({
      transport,
      mode: "minimal",
      text: "minimal",
      runId: "run-1",
    });
    expect(minimal.text).toBe("minimal\n\n▸ Working · 2m · reply to steer");

    const activity = await sendIntermediate({
      transport,
      mode: "activity",
      text: "activity",
      runId: "run-1",
    });
    expect(activity.text).toContain(
      "▸ Running a very long test suite with many extra words here · 2m",
    );

    await finalize("telegram:chat-1", "run-1");
    const fallback = await sendIntermediate({
      transport,
      mode: "activity",
      text: "fallback",
      runId: "run-2",
    });
    expect(fallback.text).toContain("▸ Working · 0s");
  });

  it("retries a failed strip once on the next flush, then drops it", async () => {
    const transport = createTransport();
    const first = await sendIntermediate({ transport, text: "first" });
    transport.edit.mockRejectedValueOnce(new Error("edit failed"));

    const second = await sendIntermediate({ transport, text: "second" });
    expect(transport.messages.get(first.id)).toContain("▸ Working");

    await finalize("telegram:chat-1");
    expect(transport.messages.get(first.id)).toBe("first");
    expect(transport.messages.get(second.id)).toBe("second");
    // failed strip + finalize retry + second-message strip
    expect(transport.edit).toHaveBeenCalledTimes(3);
  });

  it("retries a strip that fails during terminal cleanup within the same finalize", async () => {
    const transport = createTransport();
    const runId = "run-terminal";
    const sent = await sendIntermediate({ transport, text: "working", runId });
    transport.edit.mockRejectedValueOnce(new Error("edit failed"));

    await finalizeStatusFooterRun(runId);
    expect(transport.messages.get(sent.id)).toBe("working");
    // failed strip + in-finalize retry
    expect(transport.edit).toHaveBeenCalledTimes(2);
  });

  it("drops a strip permanently after its single retry also fails", async () => {
    const transport = createTransport();
    await sendIntermediate({ transport, text: "first" });
    transport.edit.mockRejectedValueOnce(new Error("edit failed"));
    await sendIntermediate({ transport, text: "second" });
    transport.edit.mockRejectedValueOnce(new Error("retry failed"));

    await finalize("telegram:chat-1");
    const editCallsAfterFinalize = transport.edit.mock.calls.length;
    await finalize("telegram:chat-1");
    expect(transport.edit.mock.calls.length).toBe(editCallsAfterFinalize);
  });

  it("keeps the previous footer when a replacement send fails", async () => {
    const transport = createTransport();
    const first = await sendIntermediate({ transport, text: "first" });
    transport.send.mockRejectedValueOnce(new Error("send failed"));

    await expect(sendIntermediate({ transport, text: "second" })).rejects.toThrow("send failed");
    expect(transport.messages.get(first.id)).toContain("▸ Working");
    expect(transport.edit).not.toHaveBeenCalled();

    await finalize("telegram:chat-1");
    expect(transport.messages.get(first.id)).toBe("first");
  });

  it("truncates emoji-heavy activity without splitting surrogate pairs", async () => {
    const transport = createTransport();
    noteActivity("telegram:chat-1", "🧪".repeat(80));

    const sent = await sendIntermediate({ transport, text: "emoji" });
    expect(() => encodeURIComponent(sent.text)).not.toThrow();
    expect(sent.text).toContain("…");
  });

  it("serializes rapid intermediate relocation", async () => {
    const transport = createTransport();
    let releaseFirst: (() => void) | undefined;
    transport.send.mockImplementationOnce(
      async (text) =>
        await new Promise<SentMessage>((resolve) => {
          releaseFirst = () => resolve({ id: "slow", text });
        }),
    );

    const first = sendIntermediate({ transport, text: "first" });
    const second = sendIntermediate({ transport, text: "second" });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(transport.edit).toHaveBeenCalledWith("slow", "first");
    expect(transport.send.mock.calls.map(([text]) => text)).toEqual([
      "first\n\n▸ Working · 0s · reply to steer",
      "second\n\n▸ Working · 0s · reply to steer",
    ]);
  });

  it("serializes run cleanup behind a pending intermediate send", async () => {
    const transport = createTransport();
    let releaseSend: (() => void) | undefined;
    transport.send.mockImplementationOnce(
      async (text) =>
        await new Promise<SentMessage>((resolve) => {
          releaseSend = () => resolve({ id: "pending", text });
        }),
    );

    const send = sendIntermediate({ transport, text: "pending", runId: "run-pending" });
    const cleanup = finalizeStatusFooterRun("run-pending");
    await vi.waitFor(() => expect(releaseSend).toBeTypeOf("function"));
    releaseSend?.();
    await Promise.all([send, cleanup]);

    expect(transport.edit).toHaveBeenCalledWith("pending", "pending");
  });

  it("keeps cleanup pending across overlapping decorations for one conversation", async () => {
    const transport = createTransport();
    let releaseSecond: (() => void) | undefined;
    transport.send.mockResolvedValueOnce({ id: "first", text: "first" }).mockImplementationOnce(
      async (text) =>
        await new Promise<SentMessage>((resolve) => {
          releaseSecond = () => resolve({ id: "second", text });
        }),
    );

    const first = sendIntermediate({ transport, text: "first", runId: "run-overlap" });
    const second = sendIntermediate({ transport, text: "second", runId: "run-overlap" });
    await first;
    await vi.waitFor(() => expect(releaseSecond).toBeTypeOf("function"));
    const cleanup = finalizeStatusFooterRun("run-overlap");
    releaseSecond?.();
    await Promise.all([second, cleanup]);

    expect(transport.edit).toHaveBeenCalledWith("second", "second");
  });

  it("suppresses a late decoration after run cleanup", async () => {
    const transport = createTransport();
    await finalizeStatusFooterRun("run-finished");

    const sent = await sendIntermediate({
      transport,
      text: "late",
      runId: "run-finished",
    });

    expect(sent.text).toBe("late");
    expect(transport.edit).not.toHaveBeenCalled();
  });

  it("ignores late activity after run cleanup", async () => {
    const transport = createTransport();
    await finalizeStatusFooterRun("run-finished");
    noteActivity("telegram:chat-1", "Stale activity", "run-finished");

    const sent = await sendIntermediate({ transport, text: "new run" });

    expect(sent.text).toContain("▸ Working · 0s");
    expect(sent.text).not.toContain("Stale activity");
  });

  it("isolates account and thread conversation keys", () => {
    const first = createStatusFooterConversationKey("telegram", "chat-1", {
      accountId: "one",
      threadId: 1,
    });
    expect(first).not.toBe(
      createStatusFooterConversationKey("telegram", "chat-1", {
        accountId: "two",
        threadId: 1,
      }),
    );
    expect(first).not.toBe(
      createStatusFooterConversationKey("telegram", "chat-1", {
        accountId: "one",
        threadId: 2,
      }),
    );
  });

  it("keeps escaped activity footers within the reserved chunk budget", async () => {
    const transport = createTransport();
    noteActivity("telegram:chat-1", "&".repeat(60));
    const sent = await decorateIntermediate({
      conversationKey: "telegram:chat-1",
      mode: "activity",
      textWithoutFooter: "message",
      send: transport.send,
      getMessageId: (result) => result.id,
      edit: transport.edit,
      now: () => 0,
      escapeHtml: true,
    });

    expect(sent.text.length - "message".length).toBeLessThanOrEqual(
      STATUS_FOOTER_MAX_RENDERED_CHARS,
    );
  });
});

describe("resolveStatusFooterMode", () => {
  it("resolves plain, channel, default, and built-in values", () => {
    expect(
      resolveStatusFooterMode({ messages: { statusFooter: "minimal" } } as OpenClawConfig, "slack"),
    ).toBe("minimal");
    const mapped = {
      messages: { statusFooter: { default: "off", telegram: "activity" } },
    } as OpenClawConfig;
    expect(resolveStatusFooterMode(mapped, "telegram")).toBe("activity");
    expect(resolveStatusFooterMode(mapped, "unknown")).toBe("off");
    expect(resolveStatusFooterMode({} as OpenClawConfig, "unknown")).toBe("activity");
  });
});
