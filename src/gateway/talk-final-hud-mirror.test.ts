// Tests realtime Talk final HUD mirroring payloads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mirrorTalkFinalHud } from "./talk-final-hud-mirror.js";

function cfg() {
  return {
    talk: {
      realtime: {
        finalHud: {
          enabled: true,
          baseUrl: "http://127.0.0.1:18802",
          streamChannel: "voice",
          monitorKind: "talk",
        },
      },
    },
  } as never;
}

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyForCall(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body?: string };
  return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
}

function requireFetchCall(fetchMock: ReturnType<typeof stubFetch>, suffix: string): unknown[] {
  const call = fetchMock.mock.calls.find((candidate) => String(candidate[0]).endsWith(suffix));
  if (!call) {
    throw new Error(`Expected fetch call ending with ${suffix}`);
  }
  return [...call];
}

describe("talk final HUD mirror", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts speaking closeouts to stream, pulse, and monitor endpoints", async () => {
    const fetchMock = stubFetch();

    await mirrorTalkFinalHud({
      cfg: cfg(),
      text: "Done with the check.",
      status: "speaking",
      detail: "Scheduled through realtime voice provider.",
      source: "agent-final",
      sessionId: "relay-1",
      runId: "run-1",
      callId: "call-1",
      provider: "xai",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0]).toSorted()).toEqual([
      "http://127.0.0.1:18802/api/monitor/report",
      "http://127.0.0.1:18802/api/pulse",
      "http://127.0.0.1:18802/api/stream",
    ]);
    const stream = bodyForCall(requireFetchCall(fetchMock, "/api/stream"));
    expect(stream).toEqual({
      text: "Done with the check.",
      channel: "voice",
      level: "info",
    });
    const monitor = bodyForCall(requireFetchCall(fetchMock, "/api/monitor/report"));
    expect(monitor).toMatchObject({
      kind: "talk",
      entries: [
        expect.objectContaining({
          id: "realtime-final-voice",
          status: "speaking",
          sessionId: "relay-1",
          runId: "run-1",
          callId: "call-1",
          provider: "xai",
        }),
      ],
    });
  });

  it("posts degraded delivery details when no speakable text is available", async () => {
    const fetchMock = stubFetch();

    await mirrorTalkFinalHud({
      cfg: cfg(),
      text: "",
      status: "degraded",
      detail: "No speakable final text was returned.",
      source: "agent-final",
      sessionId: "relay-1",
    });

    const stream = bodyForCall(requireFetchCall(fetchMock, "/api/stream"));
    expect(stream).toEqual({
      text: "No speakable final text was returned.",
      channel: "voice",
      level: "warn",
    });
    const pulse = bodyForCall(requireFetchCall(fetchMock, "/api/pulse"));
    expect(pulse).toEqual({
      source: "voice",
      intensity: 0.85,
      label: "voice degraded",
    });
  });

  it("does not post to non-loopback HUD URLs", async () => {
    const fetchMock = stubFetch();

    await mirrorTalkFinalHud({
      cfg: {
        talk: {
          realtime: {
            finalHud: {
              enabled: true,
              baseUrl: "https://hud.example.com",
            },
          },
        },
      } as never,
      text: "Done.",
      status: "speaking",
      sessionId: "relay-1",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
