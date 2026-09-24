import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MeetingJoinRequest } from "../../meeting-bot/plugin-entry.js";
import type {
  MeetingPluginSession,
  MeetingPluginChromeHealth,
} from "../../meeting-bot/session-types.js";
import {
  meetingBrowserActScripts as browserActScripts,
  type MeetingBrowserFixture,
} from "./meeting-browser.js";

type Session = MeetingPluginSession<
  "chrome" | "chrome-node",
  "agent" | "bidi" | "transcribe",
  MeetingPluginChromeHealth<string, string>
>;
type Runtime = {
  join(request: MeetingJoinRequest): Promise<{ session: Session }>;
  list(): Session[];
  status(sessionId?: string): Promise<{ found: boolean; session?: Session }>;
  leave(sessionId: string): Promise<unknown>;
  transcript(sessionId: string): Promise<unknown>;
  speak(sessionId: string, message: string): Promise<unknown>;
};

export function defineMeetingSessionFlowTests(options: {
  createFixture(options?: {
    config?: unknown;
    harness?: { tabOpen?: boolean };
    fullConfig?: OpenClawConfig;
  }): { harness: MeetingBrowserFixture; runtime: Runtime };
  url: string;
  tabId: string;
  rewrittenUrl: string;
  rewrittenUrlTestName: string;
  endedHealth: Partial<MeetingPluginChromeHealth<string, string>>;
}) {
  const joinMeeting = (runtime: Runtime, request: Partial<MeetingJoinRequest> = {}) =>
    runtime.join({ url: options.url, mode: "transcribe", ...request });
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const { harness, runtime } = options.createFixture({
      fullConfig: { agents: { list: [{ id: "operator", default: true }] } },
    });

    const first = await joinMeeting(runtime);
    expect(first.session.agentId).toBe("operator");
    expect(first.session.chrome?.health).toMatchObject({ inCall: true, cameraOff: true });

    const reused = await joinMeeting(runtime, {
      url: `${options.url.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
    });
    expect(reused.session.id).toBe(first.session.id);
    expect(runtime.list()).toHaveLength(1);

    expect(await runtime.status(first.session.id)).toMatchObject({
      found: true,
      session: { id: first.session.id },
    });
    const transcriptStartCall = harness.gatewayRequest.mock.calls.length;
    expect(await runtime.transcript(first.session.id)).toMatchObject({
      found: true,
      lines: [],
      nextIndex: 0,
    });
    const transcriptActScripts = browserActScripts(harness, transcriptStartCall);
    expect(transcriptActScripts).toHaveLength(2);
    expect(transcriptActScripts[0]).toContain("const allowSessionAdoption = false");
    expect(transcriptActScripts[0]).toContain("const captureCaptions = true");
    expect(transcriptActScripts[1]).toContain("expectedSessionId");
    expect(await runtime.speak(first.session.id, "hello")).toMatchObject({
      found: true,
      spoken: false,
    });
    Object.assign(first.session.chrome?.health ?? {}, {
      audioInputActive: true,
      audioInputRouted: true,
      audioOutputActive: true,
      audioOutputRouted: true,
      captioning: true,
      providerConnected: true,
      realtimeReady: true,
    });
    expect(await runtime.leave(first.session.id)).toMatchObject({
      found: true,
      browserLeft: true,
      session: {
        state: "ended",
        chrome: {
          health: {
            audioInputActive: false,
            audioInputRouted: false,
            audioOutputActive: false,
            audioOutputRouted: false,
            captioning: false,
            ...options.endedHealth,
            providerConnected: false,
            realtimeReady: false,
          },
        },
      },
    });
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("reads an archived transcript without reclaiming a newer live tab owner", async () => {
    const { harness, runtime } = options.createFixture();
    const joined = await joinMeeting(runtime);
    harness.state.sessionConflict = true;
    harness.gatewayRequest.mockClear();

    expect(await runtime.transcript(joined.session.id)).toMatchObject({
      found: true,
      lines: [{ text: "Archived caption" }],
    });
    const actScripts = browserActScripts(harness);
    expect(actScripts).toHaveLength(2);
    expect(actScripts[0]).toContain("const allowSessionAdoption = false");
    expect(actScripts[1]).toContain("expectedSessionId");
  });

  it("recovers and leaves a manually opened tab when Chrome launching is disabled", async () => {
    const { harness, runtime } = options.createFixture({
      harness: { tabOpen: true },
      config: {
        defaultMode: "transcribe",
        chrome: { launch: false, waitForInCallMs: 1 },
      },
    });

    const joined = await joinMeeting(runtime);
    expect(joined.session.chrome).toMatchObject({
      browserTab: { openedByPlugin: false, targetId: options.tabId },
      launched: false,
    });
    expect(harness.gatewayRequest).not.toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.anything(),
    );
    expect(await runtime.leave(joined.session.id)).toMatchObject({
      browserLeft: true,
      session: { state: "ended" },
    });
  });

  it("refreshes a recovered browser tab target", async () => {
    const { harness, runtime } = options.createFixture();
    const joined = await joinMeeting(runtime);
    harness.state.targetId = `${options.tabId}-replaced`;

    await runtime.status(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: `${options.tabId}-replaced`,
    });

    harness.state.targetId = `${options.tabId}-replaced-again`;
    harness.gatewayRequest.mockClear();
    await runtime.transcript(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: `${options.tabId}-replaced-again`,
    });
    const transcriptRead = harness.gatewayRequest.mock.calls.find(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return params.path === "/act" && typeof fn === "string" && fn.includes("expectedSessionId");
    });
    expect(transcriptRead?.[1]).toMatchObject({
      body: { targetId: `${options.tabId}-replaced-again` },
    });
  });

  it(options.rewrittenUrlTestName, async () => {
    const { harness, runtime } = options.createFixture();
    const joined = await joinMeeting(runtime);
    harness.state.tabUrl = options.rewrittenUrl;
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(joined.session.id);

    expect(status.session?.chrome?.health?.browserUrl).toBe(options.rewrittenUrl);
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: options.tabId }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });
}
