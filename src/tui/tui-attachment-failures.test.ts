import { describe, expect, it, onTestFinished, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { ChatLog } from "./components/chat-log.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { makeTuiState } from "./tui-event-test-support.js";
import { extractTextFromMessage, extractTuiAbortedText } from "./tui-formatters.js";
import { getTuiSessionProjection, reduceTuiSessionProjection } from "./tui-session-projection.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const audioFailure = {
  type: "attachment_error",
  attachment: { code: "delivery-failed", kind: "audio", label: "Generated audio 1" },
};
const audioReceipt = "⚠️ audio attachment: Delivery failed. Try sending this file again.";
const recordingReceipt = `Your recording\n${audioReceipt}`;
const caption = { type: "text", text: "Your recording" };
const image = { type: "image", url: "file:///private/image.png" };
const assistant = (content: readonly unknown[]) => ({ role: "assistant", content });
const privateMetadata = {
  label: "\x1b]52;c;private-clipboard\x07file:///private/name",
  url: "https://private.invalid/file?ticket=private",
  mimeType: "private/type",
};
const missingImage = "⚠️ image attachment: File not found. Check the path and try again.";
const blockedVideo =
  "⚠️ video attachment: Rejected by the local attachment allowlist. Send a supported file type.";
const failedFile = "⚠️ file attachment: Delivery failed. Try sending this file again.";
function privateAttachment(kind: string, code: string) {
  const attachment = { kind, code, ...privateMetadata };
  return assistant([{ type: "attachment_error", attachment }]);
}

function createDisplayHarness() {
  const state = makeTuiState({
    sessionMainKey: "main",
    sessionScope: "per-sender",
    sessionInfo: {},
  });
  const chatLog = new ChatLog();
  const handlers = createEventHandlers({
    state,
    chatLog,
    tui: { requestRender: vi.fn() },
    btw: { clear: vi.fn(), showResult: vi.fn() },
    setActivityStatus: (value) => {
      state.activityStatus = value;
    },
    updateFooter: vi.fn(),
    loadHistory: async () => ({ loaded: false }),
    streamingWatchdogMs: 0,
  });
  onTestFinished(handlers.dispose);
  return {
    state,
    chatLog,
    ...handlers,
    visible: () =>
      chatLog
        .render(160)
        .map((line) => stripAnsi(line).trimEnd())
        .join("\n")
        .trim(),
  };
}

describe("TUI attachment failure presentation", () => {
  it.each([
    ["caption and failure", assistant([caption, audioFailure]), recordingReceipt],
    ["caption, success and failure", assistant([caption, image, audioFailure]), recordingReceipt],
    ["two failures", assistant([audioFailure, audioFailure]), `${audioReceipt}\n${audioReceipt}`],
    ["private missing image", privateAttachment("image", "file-not-found"), missingImage],
    ["private blocked video", privateAttachment("video", "unsupported-format"), blockedVideo],
    ["private failed file", privateAttachment("document", "delivery-failed"), failedFile],
  ] as const)(
    "renders %s in history and final output without source metadata",
    (_name, message, expected) => {
      expect(extractTextFromMessage(message)).toBe(expected);
      expect(new TuiStreamAssembler().finalize("run-1", message, false)).toBe(expected);
    },
  );

  it.each([false, true])(
    "retains streamed captions and thinking visibility (%s) before a failure-only final",
    (showThinking) => {
      const assembler = new TuiStreamAssembler();
      assembler.ingestDelta(
        "run-1",
        assistant([caption, { type: "thinking", thinking: "Preparing" }]),
        showThinking,
      );
      expect(assembler.finalize("run-1", assistant([audioFailure]), showThinking)).toBe(
        `${showThinking ? "[thinking]\nPreparing\n\n" : ""}Your recording\n${audioReceipt}`,
      );
    },
  );

  it("keeps genuine errors ahead of success fallback while appending the failure receipt", () => {
    const message = {
      ...assistant([image, audioFailure]),
      stopReason: "error",
      errorMessage: "generation stopped",
    };
    expect(extractTextFromMessage(message)).toBe(`generation stopped\n${audioReceipt}`);
    expect(
      new TuiStreamAssembler().finalize(
        "run-1",
        assistant([image, audioFailure]),
        false,
        "generation stopped",
      ),
    ).toBe(`generation stopped\n${audioReceipt}`);
  });

  it.each([
    ["failure only", [audioFailure], false, audioReceipt],
    ["mixed attachments", [image, audioFailure], false, `Attached image\n${audioReceipt}`],
    ["streamed caption", [image, audioFailure], true, recordingReceipt],
  ] as const)(
    "renders one receipt through optimistic and authoritative history: %s",
    (_name, content, streamed, expected) => {
      const harness = createDisplayHarness();
      const event = { runId: "run-1", sessionKey: harness.state.currentSessionKey };
      if (streamed) {
        harness.handleChatEvent({ ...event, state: "delta", message: assistant([caption]) });
        expect(harness.visible()).toBe("Your recording");
      }
      const message = assistant(content);
      harness.handleChatEvent({ ...event, state: "final", message });
      expect(harness.visible()).toBe(expected);
      expect(harness.state.activityStatus).toBe("idle");
      for (const messages of [
        [],
        [
          {
            ...assistant(streamed ? [caption, ...content] : content),
            __openclaw: { id: "assistant-1", seq: 1, runId: event.runId },
          },
        ],
      ]) {
        const projection = reduceTuiSessionProjection(harness.state, {
          type: "snapshotLoaded",
          messages,
        });
        expect(projection.messages).toHaveLength(1);
        harness.chatLog.clearAll();
        for (const row of projection.messages) {
          harness.chatLog.finalizeAssistant(extractTextFromMessage(row));
        }
        expect(harness.visible()).toBe(expected);
      }
    },
  );

  it("keeps failure-only aborts diagnostic and ignores a late attachment final", () => {
    const harness = createDisplayHarness();
    const event = {
      runId: "run-1",
      sessionKey: harness.state.currentSessionKey,
      message: assistant([audioFailure]),
    };
    expect(extractTuiAbortedText(event.message, false)).toBe("");
    harness.handleChatEvent({ ...event, state: "aborted" });
    harness.handleChatEvent({ ...event, state: "final" });
    expect(harness.visible()).toBe("run aborted");
    expect(getTuiSessionProjection(harness.state).messages).toHaveLength(0);
  });

  it("does not invent failure output for empty or unsupported blocks", () => {
    for (const content of [
      [],
      [{ type: "tool_use", name: "search" }],
      [{ type: "attachment_error", attachment: { code: "unknown", kind: "audio" } }],
    ]) {
      const message = assistant(content);
      expect(extractTextFromMessage(message)).toBe("");
      expect(new TuiStreamAssembler().finalize("run-1", message, false)).toBe("(no output)");
    }
  });
});
