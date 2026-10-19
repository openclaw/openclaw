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

type ChromeLaunch = (
  params: MeetingChromeLaunchParams<MeetingChromeTransportConfig, "agent">,
) => Promise<unknown>;
const browserScript = (params?: Record<string, unknown>) =>
  (params?.body as { fn?: string } | undefined)?.fn;
const leavesBrowser = (params?: Record<string, unknown>) =>
  params?.method === "DELETE" || Boolean(browserScript(params)?.includes("leaveAction"));

type ChromeFixtureOptions = MeetingBrowserFixtureOptions & {
  nodeCommand: string;
  preserveTrackedBrowser: boolean;
  resolveConfig(value: unknown): MeetingChromeTransportConfig;
  launchInChrome: ChromeLaunch;
  launchOnNode: ChromeLaunch;
  engineMocks: {
    localDispose: ReturnType<typeof vi.fn>;
    nodeDispose: ReturnType<typeof vi.fn>;
    startAgent: ReturnType<typeof vi.fn>;
  };
};

export function defineMeetingChromeCleanupTests(options: ChromeFixtureOptions) {
  const logger = createMeetingLogger();
  const launchParams = (
    runtime: MeetingBrowserFixture["runtime"],
    recovering = false,
  ): MeetingChromeLaunchParams<MeetingChromeTransportConfig, "agent"> => ({
    config: options.resolveConfig({
      chrome: { waitForInCallMs: 1, ...(recovering ? { launch: false } : {}) },
    }),
    fullConfig: {},
    logger,
    meetingSessionId: "session-1",
    mode: "agent",
    runtime,
    url: options.url,
    ...(recovering ? { trackedTargetId: options.tabId } : {}),
  });
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

  afterEach(() => vi.restoreAllMocks());
  const browserOptions = (tabOpen: boolean) => ({ ...options, tabOpen, status: readyStatus });
  async function failStartup<T extends MeetingBrowserFixture>(
    browser: T,
    launch = options.launchInChrome,
    recovering = false,
  ) {
    await expect(launch(launchParams(browser.runtime, recovering))).rejects.toThrow(
      "realtime startup failed",
    );
    expectAudioCaptureReleased(browser.state);
    return browser;
  }

  it.each([true, false])("cleans up failed local startup (recovering=%s)", async (recovering) => {
    const { state, gatewayRequest } = await failStartup(
      createMeetingBrowserFixture(browserOptions(recovering)),
      options.launchInChrome,
      recovering,
    );
    if (recovering) {
      const requests = gatewayRequest.mock.calls.map(([, params]) => params);
      const evaluated = requests.find(
        (params) => params.path === "/act" && !browserScript(params)?.includes("leaveAction"),
      );
      expect(browserScript(evaluated)).toContain("const autoJoin = true");
      if (options.preserveTrackedBrowser) {
        expect(requests.some(leavesBrowser)).toBe(false);
        expect(state.tabOpen).toBe(true);
      }
    } else {
      expect(options.engineMocks.localDispose).toHaveBeenCalled();
      expect(gatewayRequest).toHaveBeenCalledWith(
        "browser.request",
        expect.objectContaining({ method: "DELETE", path: `/tabs/${options.tabId}` }),
        expect.anything(),
      );
      expect(state.tabOpen).toBe(false);
    }
  });

  it.each(options.preserveTrackedBrowser ? [false, true] : [false])(
    "cleans up failed node startup (recovering=%s)",
    async (recovering) => {
      const { state, invoke } = await failStartup(
        createMeetingNodeBrowserFixture(browserOptions(recovering)),
        options.launchOnNode,
        recovering,
      );
      expect(options.engineMocks.nodeDispose).toHaveBeenCalled();
      const requests = invoke.mock.calls.map(([request]) => request);
      if (recovering) {
        const browserRequests = requests.filter((request) => request.command === "browser.proxy");
        expect(
          browserRequests.some((request) =>
            leavesBrowser(request.params as Record<string, unknown>),
          ),
        ).toBe(false);
      } else {
        expect(
          requests.filter(
            (request) =>
              request.command === options.nodeCommand &&
              (request.params as Record<string, unknown>)?.action === "stopByUrl",
          ),
        ).toHaveLength(2);
        expect(
          requests.some(
            (request) =>
              request.command === "browser.proxy" &&
              (request.params as Record<string, unknown>)?.method === "DELETE",
          ),
        ).toBe(true);
      }
      expect(state.tabOpen).toBe(recovering);
    },
  );
}
