import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";
import * as realtimeTalkInput from "./talk/input.ts";

const catalog = (ready: boolean) => ({ realtime: { ready }, transcription: { ready } });
type Request = (method: string) => Promise<unknown>;
let picker: ComposerMicrophoneOwner;
function expectStatus(status: string) {
  expect(picker).toMatchObject({ realtimeStatus: status, dictationStatus: status });
}
function connect(request: Request, update: () => void = vi.fn(), sessionKey?: string) {
  const client = { request } as unknown as GatewayBrowserClient;
  picker = new ComposerMicrophoneOwner();
  picker.subscribe(update);
  picker.syncCatalog(client, true, sessionKey);
  return client;
}

afterEach(() => {
  picker?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["session", "dispose"] as const)(
  "retires stale catalog requests after %s",
  async (transition) => {
    const session = transition === "session";
    const stale = createDeferred<ReturnType<typeof catalog>>();
    const current = createDeferred<ReturnType<typeof catalog>>();
    const readCatalog = vi
      .fn()
      .mockResolvedValueOnce(catalog(session))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    if (!session) {
      readCatalog.mockResolvedValue(catalog(true));
    }
    const request = vi.fn((method: string) =>
      method === "talk.config" ? Promise.resolve({}) : readCatalog(),
    );
    let updated = createDeferred();
    const requestUpdate = vi.fn(() => {
      if (picker.realtimeStatus !== "checking") {
        updated.resolve();
      }
    });
    const client = connect(request, requestUpdate, session ? "agent:first:main" : undefined);
    await updated.promise;
    expectStatus(session ? "ready" : "unavailable");
    window.dispatchEvent(new Event("focus"));
    updated = createDeferred();
    if (session) {
      picker.syncCatalog(client, true, "agent:second:main");
      expectStatus("checking");
      expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "agent:second:main" });
    } else {
      expect(readCatalog).toHaveBeenCalledTimes(2);
      picker.dispose();
      window.dispatchEvent(new Event("focus"));
      expect(readCatalog).toHaveBeenCalledTimes(2);
      expect(picker.realtimeStatus).toBe("unknown");
      picker.syncCatalog(client, true);
    }
    current.resolve(catalog(!session));
    await updated.promise;
    const status = session ? "unavailable" : "ready";
    expectStatus(status);
    requestUpdate.mockClear();
    stale.resolve(catalog(session));
    await stale.promise;
    await Promise.resolve();
    expectStatus(status);
    expect(requestUpdate).not.toHaveBeenCalled();
    if (session) {
      picker.syncCatalog(client, true, "agent:second:main");
      expect(readCatalog).toHaveBeenCalledTimes(3);
    } else {
      window.dispatchEvent(new Event("focus"));
      expect(readCatalog).toHaveBeenCalledTimes(4);
      picker.syncCatalog(client, false);
      window.dispatchEvent(new Event("focus"));
      expect(readCatalog).toHaveBeenCalledTimes(4);
    }
  },
);

it("refreshes after returning from login on the same Gateway connection", async () => {
  let ready = false;
  const request = vi.fn(async (method: string) => (method === "talk.config" ? {} : catalog(ready)));
  connect(request);
  await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));

  ready = true;
  window.dispatchEvent(new Event("focus"));

  await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
  expect(picker).toMatchObject({ dictationStatus: "ready", open: false });
  expect(request).toHaveBeenCalledTimes(4);
  expect(request).toHaveBeenCalledWith("talk.catalog", {});
});

it.each([
  ["configured Talk", "openai", true, false, false, true],
  ["unconfigured Talk", "openai", false, false, false, false],
  ["configured TTS", undefined, false, true, false, true],
  ["TTS fallback", undefined, false, false, true, true],
  ["no speech", undefined, false, false, false, false],
] as const)(
  "admits split Talk only with %s output",
  async (_, talkProvider, talkReady, ttsReady, fallbackReady, ready) => {
    const loaded = createDeferred();
    const responses: Record<string, unknown> = {
      "talk.config": {
        config: { talk: { provider: talkProvider, realtime: { mode: "stt-tts" } } },
      },
      "tts.status": {
        provider: "openai",
        providerStates: [{ id: "openai", configured: ttsReady }],
        fallbackProviders: fallbackReady ? ["kokoro"] : [],
      },
      "talk.catalog": {
        realtime: { ready: false },
        transcription: { ready: true },
        speech: {
          activeProvider: talkProvider,
          providers: [
            { id: "openai", configured: talkReady },
            { id: "other", configured: true },
          ],
        },
      },
    };
    const request = vi.fn(async (method: string) => responses[method]);
    connect(request, () => {
      if (picker.realtimeStatus !== "checking") {
        loaded.resolve();
      }
    });
    await loaded.promise;
    expect(picker).toMatchObject({
      realtimeStatus: ready ? "ready" : "unavailable",
      dictationStatus: "ready",
    });
    expect(request.mock.calls.some(([method]) => method === "tts.status")).toBe(!talkProvider);
  },
);

it.each(["close", "dispose", "replace", "remain open"] as const)(
  "media permission lifetime: %s during pending discovery",
  async (transition) => {
    const initial = createDeferred<MediaDeviceInfo[]>();
    const replacement = createDeferred<MediaDeviceInfo[]>();
    const enumerateDevices = vi.fn().mockReturnValueOnce(initial.promise);
    if (transition === "replace") {
      enumerateDevices.mockReturnValueOnce(replacement.promise);
    }
    enumerateDevices.mockResolvedValue([]);
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices, getUserMedia, addEventListener, removeEventListener },
    });
    const discovery = vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs");
    picker = new ComposerMicrophoneOwner();
    picker.handleOpen();
    expect(enumerateDevices).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    if (transition === "dispose") {
      picker.dispose();
    } else if (transition !== "remain open") {
      picker.handleClose();
    }
    if (transition === "replace") {
      picker.handleOpen();
    }
    initial.resolve([]);
    async function waitDiscovery(index: number) {
      const result = discovery.mock.results[index];
      assert.isDefined(result);
      await result.value;
    }
    await waitDiscovery(0);
    const staleProbes = getUserMedia.mock.calls.length;
    if (transition === "replace") {
      replacement.resolve([]);
      await waitDiscovery(1);
    }
    expect(staleProbes).toBe(transition === "remain open" ? 1 : 0);
    const permits = transition === "remain open" || transition === "replace";
    expect(getUserMedia).toHaveBeenCalledTimes(permits ? 1 : 0);
    expect(stop).toHaveBeenCalledTimes(permits ? 1 : 0);
    expect(picker.open).toBe(permits);
    picker.dispose();
    expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
  },
);
