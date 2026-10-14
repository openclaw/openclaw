import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { ChatLog } from "./components/chat-log.js";
import type { TuiImageData, TuiImageRequest } from "./tui-backend.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { makeTui, makeTuiBackend } from "./tui-session-actions-test-support.js";
import { createSessionActions } from "./tui-session-actions.js";
import type { TuiStateAccess } from "./tui-types.js";

const png = createSolidPngBuffer(80, 40, { r: 20, g: 140, b: 200 }).toString("base64");
const imageData = { data: png, mimeType: "image/png" };
const image = { type: "image", data: png, mimeType: "image/png" };
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  setCapabilityOverrides({});
});

function createHarness(
  messages: unknown[] = [],
  loadImage = vi.fn<(request: TuiImageRequest) => Promise<TuiImageData>>(async () => imageData),
) {
  const state: TuiStateAccess = {
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "per-sender",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: null,
    pendingSubmit: null,
    historyLoaded: true,
    sessionInfo: {},
    initialSessionApplied: true,
    isConnected: true,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: "connected",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
  };
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
  const btw = { clear: vi.fn(), showResult: vi.fn() };
  const setActivityStatus = vi.fn();
  const updateFooter = vi.fn();
  const actions = createSessionActions({
    client,
    chatLog,
    tui,
    state,
    btw,
    setActivityStatus,
    updateFooter,
    opts: {},
    agentNames: new Map(),
    initialSessionInput: "",
    initialSessionAgentId: null,
    resolveSessionSelection: (raw) => ({ key: raw ?? "agent:main:main", agentId: "main" }),
    updateHeader: vi.fn(),
    updateAutocompleteProvider: vi.fn(),
  });
  const handlers = createEventHandlers({
    state,
    chatLog,
    tui,
    btw,
    setActivityStatus,
    updateFooter,
    loadHistory: actions.loadHistory,
    streamingWatchdogMs: 0,
  });
  cleanups.push(() => {
    handlers.dispose();
    chatLog.dispose();
  });
  return {
    state,
    chatLog,
    client,
    loadImage,
    actions,
    handlers,
    render: (width = 100) => chatLog.render(width).join("\n"),
  };
}

describe("TUI native image presentation", () => {
  it("preserves mixed content and persisted images without duplicating matching references", async () => {
    setCapabilityOverrides({ images: "kitty" });
    const first = "media://inbound/first.png";
    const second = "media://inbound/second.png";
    const harness = createHarness([
      {
        role: "user",
        content: [{ type: "image", url: first }],
        __openclaw: {
          media: [
            { kind: "image", url: first },
            { kind: "image", url: second },
          ],
        },
      },
    ]);
    await harness.actions.loadHistory();
    harness.render();
    await vi.waitFor(() => expect(harness.render().split(png)).toHaveLength(3));
    expect(harness.loadImage.mock.calls.map(([request]) => request.source)).toEqual([
      first,
      second,
    ]);
  });
  it("bounds tall iTerm2 images to their reserved terminal rows", async () => {
    setCapabilityOverrides({ images: "iterm2" });
    const portrait = createSolidPngBuffer(10, 300, { r: 20, g: 140, b: 200 }).toString("base64");
    const harness = createHarness(
      [{ role: "assistant", content: [image] }],
      vi.fn(async () => ({
        data: portrait,
        mimeType: "image/png",
      })),
    );
    await harness.actions.loadHistory();
    harness.render();
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
      const harness = createHarness([
        {
          role: "user",
          content: "Compare this image",
          __openclaw: {
            id: "user-1",
            seq: 1,
            media: [{ kind: "image", path: "media://inbound/photo.png" }],
          },
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here is the result" },
            {
              type: "attachment",
              attachment: {
                kind: "image",
                label: "Generated image",
                url: managed,
                artifactId: "artifact_managed_media_generated",
              },
            },
          ],
          __openclaw: { id: "assistant-1", seq: 2 },
        },
      ]);
      await harness.actions.loadHistory();
      harness.render();
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
        message: { role: "assistant", content: [image] },
      });
      harness.render();
      await vi.waitFor(() => expect(harness.render().split(png)).toHaveLength(4));
      expect(harness.loadImage.mock.calls[2]?.[0].source).toBe(`data:image/png;base64,${png}`);
    },
  );

  it("renders peer user attachments and tool results without reloading unchanged tool images", async () => {
    setCapabilityOverrides({ images: "kitty" });
    const harness = createHarness();
    harness.handlers.handleSessionMessageEvent({
      sessionKey: harness.state.currentSessionKey,
      sessionId: "session-1",
      message: { role: "user", content: [image], __openclaw: { id: "peer-user", seq: 1 } },
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
    const harness = createHarness([{ role: "assistant", content: [image] }]);
    await harness.actions.loadHistory();
    expect(harness.render()).toContain("Attached image");
    expect(harness.render()).not.toContain(png);
    expect(harness.loadImage).not.toHaveBeenCalled();
  });

  it("cancels image reads on session switches and ignores late pixels", async () => {
    setCapabilityOverrides({ images: "kitty" });
    const pending = createDeferred<TuiImageData>();
    const loadImage = vi.fn(async (_request: TuiImageRequest) => pending.promise);
    const harness = createHarness([{ role: "assistant", content: [image] }], loadImage);
    await harness.actions.loadHistory();
    harness.render();
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

  it("reports failed previews without exposing transport credentials or private paths", async () => {
    setCapabilityOverrides({ images: "kitty" });
    const harness = createHarness(
      [{ role: "assistant", content: [image] }],
      vi.fn(async () => {
        throw new Error("https://private.invalid/image?token=secret /private/image.png");
      }),
    );
    await harness.actions.loadHistory();
    harness.render();
    await vi.waitFor(() => expect(harness.render()).toContain("Image preview unavailable."));
    expect(harness.render()).not.toMatch(/private|token|secret/);
  });

  it("bounds previews and cancels them when scrollback is cleared", async () => {
    setCapabilityOverrides({ images: "kitty" });
    const harness = createHarness(
      Array.from({ length: 30 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `Result ${index}` }, image],
        __openclaw: { id: `image-${index}`, seq: index + 1 },
      })),
    );
    await harness.actions.loadHistory();
    harness.render();
    await vi.waitFor(() => expect(harness.loadImage).toHaveBeenCalledTimes(24));
    expect(harness.render()).toContain("Image preview limit reached.");
    harness.chatLog.clearAll();
    expect(harness.loadImage.mock.calls.every(([request]) => request.signal.aborted)).toBe(true);
    expect(harness.render()).toBe("");
  });
});
