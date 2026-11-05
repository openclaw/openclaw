import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  MeetingChromeLaunchParams,
  MeetingChromeTransportConfig,
} from "../../meeting-bot/chrome-transport-types.js";
import {
  createMeetingBrowserFixture,
  createMeetingNodeBrowserFixture,
  createMeetingLogger,
  type MeetingBrowserFixtureOptions,
  type MeetingBrowserFixture,
} from "./meeting-browser.js";

function expectAudioCaptureReleased(state: MeetingBrowserFixture["state"]) {
  expect(state.audioCaptureEvents).toEqual([
    { action: "start", captureId: expect.any(String) },
    { action: "stop", captureId: state.audioCaptureEvents[0]?.captureId },
  ]);
  expect(state.audioCaptureId).toBeUndefined();
}

type ChromeFixtureOptions = MeetingBrowserFixtureOptions & {
  nodeCommand: string;
  preserveTrackedBrowser: boolean;
  resolveConfig(value: unknown): MeetingChromeTransportConfig;
  launchInChrome(
    params: MeetingChromeLaunchParams<MeetingChromeTransportConfig, "agent">,
  ): Promise<unknown>;
  launchOnNode(
    params: MeetingChromeLaunchParams<MeetingChromeTransportConfig, "agent">,
  ): Promise<unknown>;
  engineMocks: {
    localDispose: ReturnType<typeof vi.fn>;
    nodeDispose: ReturnType<typeof vi.fn>;
    startAgent: ReturnType<typeof vi.fn>;
  };
};

export function defineMeetingChromeCleanupTests(options: ChromeFixtureOptions) {
  const logger = createMeetingLogger();
  const readyStatus = () => ({
    audioInputRouted: true,
    audioOutputRouted: true,
    inCall: true,
    micMuted: false,
    url: options.url,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    options.engineMocks.startAgent.mockRejectedValue(new Error("realtime startup failed"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps auto-join enabled when recovering an active meeting tab", async () => {
    const { state, runtime, gatewayRequest } = createMeetingBrowserFixture({
      ...options,
      tabOpen: true,
      status: readyStatus,
    });

    await expect(
      options.launchInChrome({
        config: options.resolveConfig({
          chrome: { launch: false, waitForInCallMs: 1 },
        }),
        fullConfig: {},
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        trackedTargetId: options.tabId,
        url: options.url,
      }),
    ).rejects.toThrow("realtime startup failed");

    expectAudioCaptureReleased(state);

    const evaluated = gatewayRequest.mock.calls.find(
      ([, params]) =>
        params.path === "/act" &&
        !(params.body as { fn?: string } | undefined)?.fn?.includes("leaveAction"),
    );
    expect((evaluated?.[1].body as { fn?: string } | undefined)?.fn).toContain(
      "const autoJoin = true",
    );
    if (options.preserveTrackedBrowser) {
      expect(
        gatewayRequest.mock.calls.some(
          ([, params]) =>
            params.method === "DELETE" ||
            (params.body as { fn?: string } | undefined)?.fn?.includes("leaveAction"),
        ),
      ).toBe(false);
      expect(state.tabOpen).toBe(true);
    }
  });

  it("disposes local audio and leaves the browser when realtime startup fails", async () => {
    const { state, runtime, gatewayRequest } = createMeetingBrowserFixture({
      ...options,
      tabOpen: false,
      status: readyStatus,
    });

    await expect(
      options.launchInChrome({
        config: options.resolveConfig({ chrome: { waitForInCallMs: 1 } }),
        fullConfig: {},
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        url: options.url,
      }),
    ).rejects.toThrow("realtime startup failed");

    expectAudioCaptureReleased(state);
    expect(options.engineMocks.localDispose).toHaveBeenCalled();
    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ method: "DELETE", path: `/tabs/${options.tabId}` }),
      expect.anything(),
    );
    expect(state.tabOpen).toBe(false);
  });

  it("stops node audio and leaves the remote browser when realtime startup fails", async () => {
    const { state, runtime, invoke } = createMeetingNodeBrowserFixture({
      ...options,
      tabOpen: false,
      status: readyStatus,
    });

    await expect(
      options.launchOnNode({
        config: options.resolveConfig({ chrome: { waitForInCallMs: 1 } }),
        fullConfig: {},
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        url: options.url,
      }),
    ).rejects.toThrow("realtime startup failed");

    expectAudioCaptureReleased(state);
    expect(options.engineMocks.nodeDispose).toHaveBeenCalled();
    expect(
      invoke.mock.calls.filter(
        ([request]) =>
          request.command === options.nodeCommand &&
          (request.params as Record<string, unknown>)?.action === "stopByUrl",
      ),
    ).toHaveLength(2);
    expect(
      invoke.mock.calls.some(
        ([request]) =>
          request.command === "browser.proxy" &&
          (request.params as Record<string, unknown>)?.method === "DELETE",
      ),
    ).toBe(true);
    expect(state.tabOpen).toBe(false);
  });

  if (options.preserveTrackedBrowser) {
    it("stops failed node audio recovery without leaving the active browser call", async () => {
      const { state, runtime, invoke } = createMeetingNodeBrowserFixture({
        ...options,
        tabOpen: true,
        status: readyStatus,
      });

      await expect(
        options.launchOnNode({
          config: options.resolveConfig({
            chrome: { launch: false, waitForInCallMs: 1 },
          }),
          fullConfig: {},
          logger,
          meetingSessionId: "session-1",
          mode: "agent",
          runtime,
          trackedTargetId: options.tabId,
          url: options.url,
        }),
      ).rejects.toThrow("realtime startup failed");

      expectAudioCaptureReleased(state);
      expect(options.engineMocks.nodeDispose).toHaveBeenCalled();
      expect(
        invoke.mock.calls.some(
          ([request]) =>
            request.command === "browser.proxy" &&
            ((request.params as Record<string, unknown>)?.method === "DELETE" ||
              ((request.params as { body?: { fn?: string } }).body?.fn?.includes("leaveAction") ??
                false)),
        ),
      ).toBe(false);
      expect(state.tabOpen).toBe(true);
    });
  }
}
