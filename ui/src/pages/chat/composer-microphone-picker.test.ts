import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ComposerMicrophonePicker } from "./composer-microphone-picker.ts";
import * as realtimeTalkInput from "./talk/input.ts";

function catalog(ready: boolean) {
  return {
    realtime: { ready, providers: [] },
    transcription: { ready, providers: [] },
  };
}

let picker: ComposerMicrophonePicker;

afterEach(() => {
  picker?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composer voice readiness", () => {
  it("reloads session readiness and rejects results from the previous session", async () => {
    const previous = createDeferred<ReturnType<typeof catalog>>();
    const current = createDeferred<ReturnType<typeof catalog>>();
    const readCatalog = vi
      .fn()
      .mockResolvedValueOnce(catalog(true))
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const request = vi.fn((method: string) =>
      method === "talk.config" ? Promise.resolve({}) : readCatalog(),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    let updated = createDeferred();
    const requestUpdate = vi.fn(() => updated.resolve());
    picker = new ComposerMicrophonePicker(requestUpdate);
    picker.syncCatalog(client, true, "agent:first:main");
    await updated.promise;
    expect(picker.realtimeStatus).toBe("ready");
    expect(picker.dictationStatus).toBe("ready");

    window.dispatchEvent(new Event("focus"));
    updated = createDeferred();
    picker.syncCatalog(client, true, "agent:second:main");
    expect(picker.realtimeStatus).toBe("checking");
    expect(picker.dictationStatus).toBe("checking");
    expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "agent:second:main" });
    current.resolve(catalog(false));
    await updated.promise;
    expect(picker.realtimeStatus).toBe("unavailable");
    expect(picker.dictationStatus).toBe("unavailable");

    requestUpdate.mockClear();
    previous.resolve(catalog(true));
    await previous.promise;
    await Promise.resolve();
    expect(picker.realtimeStatus).toBe("unavailable");
    expect(picker.dictationStatus).toBe("unavailable");
    expect(requestUpdate).not.toHaveBeenCalled();
    picker.syncCatalog(client, true, "agent:second:main");
    expect(readCatalog).toHaveBeenCalledTimes(3);
  });

  it("refreshes after returning from login on the same Gateway connection", async () => {
    let ready = false;
    const request = vi.fn(async (method: string) =>
      method === "talk.config" ? {} : catalog(ready),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    picker = new ComposerMicrophonePicker(vi.fn());
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));

    ready = true;
    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
    expect(picker.dictationStatus).toBe("ready");
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledWith("talk.catalog", {});
    expect(picker.open).toBe(false);
  });

  it("retires focus requests on disposal and reconnects a reused picker without stale results", async () => {
    const stale = createDeferred<ReturnType<typeof catalog>>();
    const readCatalog = vi
      .fn()
      .mockResolvedValueOnce(catalog(false))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(catalog(true));
    const request = vi.fn((method: string) =>
      method === "talk.config" ? Promise.resolve({}) : readCatalog(),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const requestUpdate = vi.fn();
    picker = new ComposerMicrophonePicker(requestUpdate);
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));
    window.dispatchEvent(new Event("focus"));
    expect(readCatalog).toHaveBeenCalledTimes(2);

    picker.dispose();
    window.dispatchEvent(new Event("focus"));
    expect(readCatalog).toHaveBeenCalledTimes(2);
    expect(picker.realtimeStatus).toBe("unknown");

    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
    requestUpdate.mockClear();
    stale.resolve(catalog(false));
    await stale.promise;
    await Promise.resolve();
    expect(picker.realtimeStatus).toBe("ready");
    expect(requestUpdate).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    expect(readCatalog).toHaveBeenCalledTimes(4);
    picker.syncCatalog(client, false);
    window.dispatchEvent(new Event("focus"));
    expect(readCatalog).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: "configured Talk output", talkProvider: "openai", talkReady: true, ready: true },
    { name: "unconfigured Talk output", talkProvider: "openai", talkReady: false, ready: false },
    { name: "configured TTS output", ttsReady: true, ready: true },
    { name: "configured TTS fallback", fallbackReady: true, ready: true },
    { name: "no speech output", ready: false },
  ])("admits split Talk only with $name", async (scenario) => {
    const loaded = createDeferred();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.config") {
        return {
          config: { talk: { provider: scenario.talkProvider, realtime: { mode: "stt-tts" } } },
        };
      }
      if (method === "tts.status") {
        return {
          provider: "openai",
          providerStates: [{ id: "openai", configured: scenario.ttsReady === true }],
          fallbackProviders: scenario.fallbackReady ? ["kokoro"] : [],
        };
      }
      return {
        realtime: { ready: false },
        transcription: { ready: true },
        speech: {
          activeProvider: scenario.talkProvider,
          providers: [
            { id: "openai", configured: scenario.talkReady === true },
            { id: "other", configured: true },
          ],
        },
      };
    });
    picker = new ComposerMicrophonePicker(() => loaded.resolve());
    picker.syncCatalog({ request } as unknown as GatewayBrowserClient, true);
    await loaded.promise;
    expect(picker.realtimeStatus).toBe(scenario.ready ? "ready" : "unavailable");
    expect(picker.dictationStatus).toBe("ready");
    expect(request.mock.calls.some(([method]) => method === "tts.status")).toBe(
      !scenario.talkProvider,
    );
  });
});

describe("media permission lifetime: composer", () => {
  it.each(["close", "dispose", "replace", "remain open"] as const)(
    "%s during pending discovery",
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
      // Call through unchanged: the returned promise only makes the actual owner boundary awaitable.
      const discovery = vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs");
      picker = new ComposerMicrophonePicker(vi.fn());
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
      const initialDiscovery = discovery.mock.results[0];
      assert.isDefined(initialDiscovery);
      await initialDiscovery.value;
      const staleProbes = getUserMedia.mock.calls.length;
      if (transition === "replace") {
        replacement.resolve([]);
        const replacementDiscovery = discovery.mock.results[1];
        assert.isDefined(replacementDiscovery);
        await replacementDiscovery.value;
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
});
