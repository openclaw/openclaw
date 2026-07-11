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

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

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
    vi.unstubAllGlobals();
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

  it("does not reject a persisted input from incomplete passive discovery", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
        ]),
      },
    });
    const state = createState();
    state.settings = { ...state.settings, gatewayUrl: "ws://passive-discovery.example" };
    state.selectRealtimeTalkInput("usb-mic");

    await state.refreshRealtimeTalkInputs(false);

    expect(state.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(state.realtimeTalkInputError).toBeNull();
  });

  it("reports a missing persisted input after successful permissioned discovery", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
        ]),
      },
    });
    const state = createState();
    state.settings = { ...state.settings, gatewayUrl: "ws://permissioned-discovery.example" };
    state.selectRealtimeTalkInput("usb-mic");

    await state.refreshRealtimeTalkInputs(true);

    expect(state.realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(state.realtimeTalkInputError).toContain("The selected microphone is unavailable");
  });

  it("keeps permission guidance when permissioned discovery is incomplete", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
          mediaDevice("audioinput", "", ""),
        ]),
        getUserMedia: vi.fn(async () => {
          throw new DOMException("denied", "NotAllowedError");
        }),
      },
    });
    const state = createState();
    state.settings = { ...state.settings, gatewayUrl: "ws://blocked-discovery.example" };
    state.selectRealtimeTalkInput("usb-mic");

    await state.refreshRealtimeTalkInputs(true);

    expect(state.realtimeTalkInputError).toContain("Microphone access is blocked");
  });
});
