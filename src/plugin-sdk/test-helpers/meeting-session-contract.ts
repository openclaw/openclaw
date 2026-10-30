import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MeetingJoinRequest } from "../../meeting-bot/plugin-entry.js";
import type * as Meeting from "../../meeting-bot/session-types.js";
import {
  meetingBrowserActScripts as browserActScripts,
  type MeetingBrowserFixture,
} from "./meeting-browser.js";

type Health = Meeting.MeetingPluginChromeHealth<string, string>;
type Mode = NonNullable<MeetingJoinRequest["mode"]>;
type Session = Meeting.MeetingPluginSession<"chrome" | "chrome-node", Mode, Health>;
type Runtime = {
  join(request: MeetingJoinRequest): Promise<{ session: Session }>;
  list(): Session[];
  status(sessionId?: string): Promise<{ found: boolean; session?: Session }>;
  speak(sessionId: string, message: string): Promise<unknown>;
} & Record<"leave" | "transcript", (sessionId: string) => Promise<unknown>>;

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
  endedHealth: Partial<Health>;
}) {
  const joinMeeting = (runtime: Runtime, request: Partial<MeetingJoinRequest> = {}) =>
    runtime.join({ url: options.url, mode: "transcribe", ...request });
  const joinedFixture = async (config?: Parameters<typeof options.createFixture>[0]) => {
    const fixture = options.createFixture(config);
    const { session } = await joinMeeting(fixture.runtime);
    return { ...fixture, session, id: session.id };
  };
  const expectTranscriptScripts = (harness: MeetingBrowserFixture, start = 0) => {
    const scripts = browserActScripts(harness, start);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("const allowSessionAdoption = false");
    expect(scripts[1]).toContain("expectedSessionId");
    return scripts;
  };
  const audioHealth = (active: boolean) => ({
    audioInputActive: active,
    audioInputRouted: active,
    audioOutputActive: active,
    audioOutputRouted: active,
    captioning: active,
    providerConnected: active,
    realtimeReady: active,
  });
  const requestArgs = (
    params: Record<string, unknown>,
    authority: unknown = expect.objectContaining({ scopes: ["operator.admin"] }),
  ) => ["browser.request", expect.objectContaining(params), authority] as const;
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const { harness, runtime, session, id } = await joinedFixture({
      fullConfig: { agents: { entries: { operator: {} } } },
    });
    expect(session).toMatchObject({
      agentId: "operator",
      chrome: { health: { inCall: true, cameraOff: true } },
    });
    const reused = await joinMeeting(runtime, {
      url: `${options.url.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
    });
    expect(reused.session.id).toBe(id);
    expect(runtime.list()).toHaveLength(1);
    expect(await runtime.status(id)).toMatchObject({ found: true, session: { id } });
    const transcriptStartCall = harness.gatewayRequest.mock.calls.length;
    expect(await runtime.transcript(id)).toMatchObject({ found: true, lines: [], nextIndex: 0 });
    const transcriptActScripts = expectTranscriptScripts(harness, transcriptStartCall);
    expect(transcriptActScripts[0]).toContain("const captureCaptions = true");
    expect(await runtime.speak(id, "hello")).toMatchObject({ found: true, spoken: false });
    Object.assign(session.chrome?.health ?? {}, audioHealth(true));
    const health = {
      ...audioHealth(false),
      ...options.endedHealth,
      providerConnected: false,
      realtimeReady: false,
    };
    expect(await runtime.leave(id)).toMatchObject({
      found: true,
      browserLeft: true,
      session: { state: "ended", chrome: { health } },
    });
    expect(harness.gatewayRequest).toHaveBeenCalledWith(...requestArgs({ path: "/tabs/open" }));
  });

  it("reads an archived transcript without reclaiming a newer live tab owner", async () => {
    const { harness, runtime, id } = await joinedFixture();
    harness.state.sessionConflict = true;
    harness.gatewayRequest.mockClear();

    const transcript = await runtime.transcript(id);
    expect(transcript).toMatchObject({ found: true, lines: [{ text: "Archived caption" }] });
    expectTranscriptScripts(harness);
  });

  it("recovers and leaves a manually opened tab when Chrome launching is disabled", async () => {
    const { harness, runtime, session, id } = await joinedFixture({
      harness: { tabOpen: true },
      config: { defaultMode: "transcribe", chrome: { launch: false, waitForInCallMs: 1 } },
    });
    expect(session.chrome).toMatchObject({
      browserTab: { openedByPlugin: false, targetId: options.tabId },
      launched: false,
    });
    expect(harness.gatewayRequest).not.toHaveBeenCalledWith(
      ...requestArgs({ path: "/tabs/open" }, expect.anything()),
    );
    const left = await runtime.leave(id);
    expect(left).toMatchObject({ browserLeft: true, session: { state: "ended" } });
  });

  it("refreshes a recovered browser tab target", async () => {
    const { harness, runtime, session, id } = await joinedFixture();
    for (const [method, suffix] of [
      ["status", "replaced"],
      ["transcript", "replaced-again"],
    ] as const) {
      const targetId = `${options.tabId}-${suffix}`;
      harness.state.targetId = targetId;
      harness.gatewayRequest.mockClear();
      await runtime[method](id);
      expect(session.chrome?.browserTab).toEqual({ openedByPlugin: false, targetId });
    }
    const transcriptRead = harness.gatewayRequest.mock.calls.find(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return params.path === "/act" && typeof fn === "string" && fn.includes("expectedSessionId");
    });
    const expectedTarget = { targetId: `${options.tabId}-replaced-again` };
    expect(transcriptRead?.[1].body).toMatchObject(expectedTarget);
  });

  it(options.rewrittenUrlTestName, async () => {
    const { harness, runtime, id } = await joinedFixture();
    harness.state.tabUrl = options.rewrittenUrl;
    harness.gatewayRequest.mockClear();
    const status = await runtime.status(id);
    expect(status.session?.chrome?.health?.browserUrl).toBe(options.rewrittenUrl);
    const request = { path: "/act", body: expect.objectContaining({ targetId: options.tabId }) };
    expect(harness.gatewayRequest).toHaveBeenCalledWith(...requestArgs(request));
  });
}
