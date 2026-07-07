// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { realtimeTalkSessionCtor, sessionStart, sessionStop } = vi.hoisted(() => ({
  realtimeTalkSessionCtor: vi.fn(function () {
    return { start: sessionStart, stop: sessionStop };
  }),
  sessionStart: vi.fn(async () => undefined),
  sessionStop: vi.fn(),
}));

vi.mock("./realtime-talk.ts", () => ({
  RealtimeTalkSession: realtimeTalkSessionCtor,
}));

import { loadSettings } from "../../app/settings.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  type ChatRealtimeState,
} from "./chat-realtime.ts";

function createState(): ChatRealtimeState {
  const settings = loadSettings();
  const state = {
    client: {},
    connected: true,
    settings,
    sessionKey: "main",
    lastError: null,
    chatError: null,
    ...createInitialChatRealtimeState(settings.realtimeTalkInputDeviceId),
    requestUpdate: vi.fn(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
  return state;
}

describe("chat realtime microphone selection", () => {
  beforeEach(() => {
    localStorage.clear();
    realtimeTalkSessionCtor.mockClear();
    sessionStart.mockClear();
    sessionStop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the selected input in memory when persistence fails and shares it across panes", async () => {
    const firstPane = createState();
    const secondPane = createState();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    firstPane.selectRealtimeTalkInput("usb-mic");
    await secondPane.toggleRealtimeTalk();

    expect(firstPane.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(secondPane.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(realtimeTalkSessionCtor).toHaveBeenCalledWith(
      secondPane.client,
      "main",
      expect.any(Object),
      {},
      { inputDeviceId: "usb-mic" },
    );
    expect(sessionStart).toHaveBeenCalledOnce();
  });
});
