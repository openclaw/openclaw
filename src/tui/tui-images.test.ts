import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { ChatLog } from "./components/chat-log.js";
import type { TuiImageData, TuiImageRequest } from "./tui-backend.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { extractTextFromMessage, extractTuiAbortedText } from "./tui-formatters.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTui,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";
import { getTuiSessionProjection, reduceTuiSessionProjection } from "./tui-session-projection.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const png = createSolidPngBuffer(80, 40, { r: 20, g: 140, b: 200 }).toString("base64");
const imageData = { data: png, mimeType: "image/png" };
const image = { type: "image", data: png, mimeType: "image/png" };
const makeMessage = (role: string, content: unknown, metadata = {}) => ({
  role,
  content,
  __openclaw: metadata,
});
const assistantImage = makeMessage("assistant", [image]);
const cleanups: Array<() => void> = [];

beforeEach(() => setCapabilityOverrides({ images: "kitty" }));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  setCapabilityOverrides({});
});

function createHarness(
  messages: unknown[] = [],
  loadImage = vi.fn<(request: TuiImageRequest) => Promise<TuiImageData>>(async () => imageData),
  overrides: {
    state?: Parameters<typeof createBaseState>[0];
    loadHistory?: Parameters<typeof createEventHandlers>[0]["loadHistory"];
  } = {},
) {
  const state = createBaseState({
    sessionScope: "per-sender",
    currentSessionId: "session-1",
    historyLoaded: true,
    ...overrides.state,
  });
  const tui = makeTui();
  const chatLog = new ChatLog(180, {
    loadImage,
    getScope: () => ({ sessionKey: state.currentSessionKey, agentId: state.currentAgentId }),
    requestRender: () => tui.requestRender(),
  });
  const client = makeTuiBackend({
    loadImage,
    loadHistory: vi.fn(async () => ({
      messages,
      sessionId: state.currentSessionId,
      sessionInfo: { key: state.currentSessionKey, sessionId: state.currentSessionId },
    })),
  });
  const context = {
    state,
    chatLog,
    tui,
    btw: { clear: vi.fn(), showResult: vi.fn() },
    setActivityStatus: vi.fn((value: string) => {
      state.activityStatus = value;
    }),
    updateFooter: vi.fn(),
  };
  const actions = createTestSessionActions({ client, ...context });
  const handlers = createEventHandlers({
    ...context,
    loadHistory: overrides.loadHistory ?? actions.loadHistory,
    streamingWatchdogMs: 0,
  });
  cleanups.push(() => {
    handlers.dispose();
    chatLog.dispose();
  });
  return {
    ...context,
    client,
    loadImage,
    actions,
    handlers,
    render: (width = 100) => chatLog.render(width).join("\n"),
    visible: () =>
      chatLog
        .render(160)
        .map((line) => stripAnsi(line).trimEnd())
        .join("\n")
        .trim(),
  };
}

async function loadHarness(...args: Parameters<typeof createHarness>) {
  const harness = createHarness(...args);
  await harness.actions.loadHistory();
  harness.render();
  return harness;
}

it("deduplicates mixed content and persisted images", async () => {
  const first = "media://inbound/first.png";
  const second = "media://inbound/second.png";
  const media = [first, second].map((url) => ({ kind: "image", url }));
  const harness = await loadHarness([
    makeMessage("user", [{ type: "image", url: first }], {
      media,
    }),
  ]);
  await vi.waitFor(() => expect(harness.render().split(png)).toHaveLength(3));
  expect(harness.loadImage.mock.calls.map(([request]) => request.source)).toEqual([first, second]);
});
it("bounds tall iTerm2 images to their reserved terminal rows", async () => {
  setCapabilityOverrides({ images: "iterm2" });
  const portrait = createSolidPngBuffer(10, 300, { r: 20, g: 140, b: 200 }).toString("base64");
  const harness = await loadHarness(
    [assistantImage],
    vi.fn(async () => ({ ...imageData, data: portrait })),
  );
  await vi.waitFor(() => expect(harness.render()).toContain(portrait));
  const output = harness.render();
  expect(output).toContain("\x1b]1337;File=");
  expect(output).toMatch(/;height=20:/);
  expect(output).not.toContain("height=auto");
});
it.each(["kitty", "iterm2"] as const)(
  "renders history and live finals with %s",
  async (protocol) => {
    setCapabilityOverrides({ images: protocol });
    const managed = "/api/chat/media/outgoing/agent%3Amain%3Amain/generated/full";
    const attachment = {
      kind: "image",
      label: "Generated image",
      url: managed,
      artifactId: "artifact_managed_media_generated",
    };
    const harness = await loadHarness([
      makeMessage("user", "Compare this image", {
        id: "user-1",
        seq: 1,
        media: [{ kind: "image", path: "media://inbound/photo.png" }],
      }),
      makeMessage(
        "assistant",
        [
          { type: "text", text: "Here is the result" },
          { type: "attachment", attachment },
        ],
        { id: "assistant-1", seq: 2 },
      ),
    ]);
    await vi.waitFor(() => expect(harness.render().split(png)).toHaveLength(3));
    expect(harness.loadImage.mock.calls.map(([request]) => request.source)).toEqual([
      "media://inbound/photo.png",
      managed,
    ]);
    const marker = protocol === "kitty" ? "\x1b_Ga=T" : "\x1b]1337;File=";
    expect(harness.render()).toContain(marker);
    expect(harness.render()).toContain("Here is the result");
    expect(harness.render(40)).toContain(marker);
    expect(harness.loadImage).toHaveBeenCalledTimes(2);

    harness.handlers.handleChatEvent({
      runId: "live-run",
      sessionKey: harness.state.currentSessionKey,
      state: "final",
      message: assistantImage,
    });
    harness.render();
    await vi.waitFor(() => expect(harness.render().split(png)).toHaveLength(4));
    expect(harness.loadImage.mock.calls[2]?.[0].source).toBe(`data:image/png;base64,${png}`);
  },
);

it("renders peer/tool images and reuses unchanged tool previews", async () => {
  const harness = createHarness();
  harness.handlers.handleSessionMessageEvent({
    sessionKey: harness.state.currentSessionKey,
    sessionId: "session-1",
    message: makeMessage("user", [image], { id: "peer-user", seq: 1 }),
  });
  harness.chatLog.startTool("tool-1", "read", {});
  harness.chatLog.updateToolResult("tool-1", { content: [image] });
  harness.render();
  await vi.waitFor(() => expect(harness.render().split(png)).toHaveLength(3));
  harness.chatLog.updateToolResult("tool-1", { content: [image] });
  harness.chatLog.setToolsExpanded(true);
  expect(harness.render()).toContain(png);
  expect(harness.loadImage).toHaveBeenCalledTimes(2);
});

it("keeps attachment labels without fetching on unsupported terminals", async () => {
  setCapabilityOverrides({ images: null });
  const harness = await loadHarness([assistantImage]);
  expect(harness.render()).toContain("Attached image");
  expect(harness.render()).not.toContain(png);
  expect(harness.loadImage).not.toHaveBeenCalled();
});

it("cancels image reads on session switches and ignores late pixels", async () => {
  const pending = createDeferred<TuiImageData>();
  const loadImage = vi.fn(async (_request: TuiImageRequest) => pending.promise);
  const harness = await loadHarness([assistantImage], loadImage);
  await vi.waitFor(() => expect(loadImage).toHaveBeenCalledOnce());
  const request = loadImage.mock.calls[0]?.[0];
  harness.client.loadHistory = vi.fn(async () => ({ messages: [], sessionInfo: {} }));
  await harness.actions.setSession("agent:main:other");
  expect(request?.signal.aborted).toBe(true);
  pending.resolve(imageData);
  await pending.promise;
  expect(harness.render()).not.toContain(png);
  expect(harness.render()).not.toContain("Loading image");
});

it("redacts credentials and paths from failed previews", async () => {
  const harness = await loadHarness(
    [assistantImage],
    vi.fn(async () => {
      throw new Error("https://private.invalid/image?token=secret /private/image.png");
    }),
  );
  await vi.waitFor(() => expect(harness.render()).toContain("Image preview unavailable."));
  expect(harness.render()).not.toMatch(/private|token|secret/);
});

it("bounds previews and cancels them when scrollback is cleared", async () => {
  const harness = await loadHarness(
    Array.from({ length: 30 }, (_, index) =>
      makeMessage("assistant", [{ type: "text", text: `Result ${index}` }, image], {
        id: `image-${index}`,
        seq: index + 1,
      }),
    ),
  );
  await vi.waitFor(() => expect(harness.loadImage).toHaveBeenCalledTimes(24));
  expect(harness.render()).toContain("Image preview limit reached.");
  harness.chatLog.clearAll();
  expect(harness.loadImage.mock.calls.every(([request]) => request.signal.aborted)).toBe(true);
  expect(harness.render()).toBe("");
});
const audioFailure = {
  type: "attachment_error",
  attachment: { code: "delivery-failed", kind: "audio", label: "Generated audio 1" },
};
const audioReceipt = "⚠️ audio attachment: Delivery failed. Try sending this file again.";
const recordingReceipt = `Your recording\n${audioReceipt}`;
const caption = { type: "text", text: "Your recording" };
const failureImage = { type: "image", url: "file:///private/image.png" };
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
  return assistant([{ type: "attachment_error", attachment: { kind, code, ...privateMetadata } }]);
}
function expectHistoryAndFinal(message: unknown, expected: string) {
  expect(extractTextFromMessage(message)).toBe(expected);
  expect(new TuiStreamAssembler().finalize("run-1", message, false)).toBe(
    expected || "(no output)",
  );
}

describe("TUI attachment failure presentation", () => {
  beforeEach(() => setCapabilityOverrides({ images: null }));
  const createDisplayHarness = () =>
    createHarness([], undefined, {
      state: { sessionMainKey: "main" },
      loadHistory: async () => ({ loaded: false }),
    });
  it.each([
    ["two failures", assistant([audioFailure, audioFailure]), `${audioReceipt}\n${audioReceipt}`],
    ["private missing image", privateAttachment("image", "file-not-found"), missingImage],
    ["private blocked video", privateAttachment("video", "unsupported-format"), blockedVideo],
    ["private failed file", privateAttachment("document", "delivery-failed"), failedFile],
  ] as const)(
    "renders %s in history and final output without source metadata",
    (_name, message, expected) => expectHistoryAndFinal(message, expected),
  );

  it("retains streamed captions and thinking before a failure-only final", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta(
      "run-1",
      assistant([caption, { type: "thinking", thinking: "Preparing" }]),
      true,
    );
    expect(assembler.finalize("run-1", assistant([audioFailure]), true)).toBe(
      `[thinking]\nPreparing\n\nYour recording\n${audioReceipt}`,
    );
  });

  it("keeps genuine errors ahead of success fallback while appending the failure receipt", () => {
    const message = {
      ...assistant([failureImage, audioFailure]),
      stopReason: "error",
      errorMessage: "generation stopped",
    };
    expect(extractTextFromMessage(message)).toBe(`generation stopped\n${audioReceipt}`);
    const final = new TuiStreamAssembler().finalize(
      "run-1",
      assistant([failureImage, audioFailure]),
      false,
      "generation stopped",
    );
    expect(final).toBe(`generation stopped\n${audioReceipt}`);
  });

  it.each([
    ["failure only", [audioFailure], false, audioReceipt],
    ["mixed attachments", [failureImage, audioFailure], false, `Attached image\n${audioReceipt}`],
    ["streamed caption", [failureImage, audioFailure], true, recordingReceipt],
  ] as const)(
    "renders one receipt through optimistic and authoritative history: %s",
    (_name, content, streamed, expected) => {
      const harness = createDisplayHarness();
      const event = { runId: "run-1", sessionKey: harness.state.currentSessionKey };
      if (streamed) {
        harness.handlers.handleChatEvent({
          ...event,
          state: "delta",
          message: assistant([caption]),
        });
        expect(harness.visible()).toBe("Your recording");
      }
      const message = assistant(content);
      harness.handlers.handleChatEvent({ ...event, state: "final", message });
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
    harness.handlers.handleChatEvent({ ...event, state: "aborted" });
    harness.handlers.handleChatEvent({ ...event, state: "final" });
    expect(harness.visible()).toBe("run aborted");
    expect(getTuiSessionProjection(harness.state).messages).toHaveLength(0);
  });

  it("does not invent failure output for empty or unsupported blocks", () => {
    for (const content of [
      [],
      [{ type: "tool_use", name: "search" }],
      [{ type: "attachment_error", attachment: { code: "unknown", kind: "audio" } }],
    ]) {
      expectHistoryAndFinal(assistant(content), "");
    }
  });
});
