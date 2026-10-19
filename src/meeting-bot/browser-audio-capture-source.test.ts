import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createMeetingBrowserAudioCaptureSource } from "./browser-audio-capture-source.js";

const makeTrack = (deviceId?: string) => ({
  readyState: "live",
  getSettings: (): { deviceId?: string } => ({ deviceId }),
});
const stream = (...tracks: ReturnType<typeof makeTrack>[]) => ({ getAudioTracks: () => tracks });

function createPage(devices?: Promise<{ kind: string; deviceId: string }[]>) {
  const localTrack = makeTrack("virtual-microphone");
  const remoteTrack = makeTrack("remote-track-id");
  const local = { srcObject: stream(localTrack), muted: false };
  const remote = { srcObject: stream(remoteTrack), muted: false };
  const elements = [local, remote];
  const bridges: {
    sessionId: string;
    bridge: typeof remote;
    source: typeof remote;
    sourceMuted: boolean;
    stream: typeof remote.srcObject;
  }[] = [];
  const connected = new Set<unknown>();
  const close = vi.fn(async () => {});
  let processAudio:
    | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void)
    | undefined;
  class AudioContext {
    state = "running";
    destination = {};
    resume = async () => {};
    close = close;
    createScriptProcessor() {
      return {
        connect() {},
        disconnect() {},
        set onaudioprocess(handler: typeof processAudio) {
          processAudio = handler;
        },
      };
    }
    createMediaStreamSource = ({ tracks }: { tracks: unknown[] }) => ({
      connect: () => tracks.forEach((track) => connected.add(track)),
      disconnect: () => tracks.forEach((track) => connected.delete(track)),
    });
  }
  class MediaStream {
    constructor(public tracks: unknown[]) {}
  }
  const state = { owner: "session-1" };
  const page = vm.createContext({
    state,
    window: { addEventListener() {}, removeEventListener() {}, audioOutputs: bridges },
    navigator: {
      mediaDevices: {
        enumerateDevices: async () =>
          devices ?? [{ kind: "audioinput", deviceId: "virtual-microphone" }],
        addEventListener() {},
        removeEventListener() {},
      },
    },
    document: {
      documentElement: {},
      querySelectorAll: () => elements,
      addEventListener() {},
      removeEventListener() {},
    },
    AudioContext,
    MediaStream,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    setInterval,
    clearInterval,
    Date,
  });
  const run = async (action: "start" | "pull" | "stop", captureId = "capture-1") => {
    const source = createMeetingBrowserAudioCaptureSource({
      action,
      captureId,
      meetingSessionId: "session-1",
      meetingUrl: "https://meeting.invalid/room",
      ownershipSource: "return state.owner === sessionId;",
      audioOutputsGlobal: "audioOutputs",
    });
    const result: unknown = await vm.runInContext(`(${source})()`, page);
    return JSON.parse(String(result)) as { base64?: string; closed?: boolean; isolated?: boolean };
  };
  return {
    local,
    remote,
    localTrack,
    remoteTrack,
    elements,
    bridges,
    connected,
    close,
    state,
    run,
    status: () => ({ remote: remote.muted, local: local.muted, tracks: [...connected] }),
    processAudio: (data: Float32Array) =>
      processAudio?.({ inputBuffer: { getChannelData: () => data } }),
  };
}

describe("browser meeting input capture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects ownership lost while discovering input devices", async () => {
    const devices = createDeferredCore<{ kind: string; deviceId: string }[]>();
    const page = createPage(devices.promise);
    const starting = page.run("start");
    page.state.owner = "session-2";
    devices.resolve([]);
    await expect(starting).rejects.toThrow(
      "Meeting changed while audio devices were being inspected",
    );
    expect(page.connected.size).toBe(0);
    expect(page.close).toHaveBeenCalledOnce();
    expect((await page.run("pull")).closed).toBe(true);
  });

  describe("active capture", () => {
    let page: ReturnType<typeof createPage>;
    beforeEach(async () => {
      page = createPage();
      await page.run("start");
    });

    it("isolates playback from device tracks, bounds backlog, and restores the exact source", async () => {
      expect(page.status()).toEqual({ remote: true, local: false, tracks: [page.remoteTrack] });
      for (let frame = 0; frame < 250; frame++) {
        page.processAudio(new Float32Array(512).fill(0.25));
      }
      const result = await page.run("pull");
      const pcm = Buffer.from(result.base64 ?? "", "base64");
      expect(pcm.byteLength).toBeLessThanOrEqual(48_128);
      expect(pcm.readInt16LE()).toBe(8192);
      expect(page.connected.has(page.localTrack)).toBe(false);
      await page.run("stop");
      expect(page.status()).toMatchObject({ remote: false, tracks: [] });
      expect(page.close).toHaveBeenCalledOnce();
    });

    it("retires replaced sources and never returns PCM after browser ownership changes", async () => {
      page.processAudio(new Float32Array([0.5]));
      page.remote.srcObject = stream();
      expect((await page.run("pull")).base64).toBe("");
      expect(page.connected.size).toBe(0);
      const replacement = makeTrack();
      page.remote.srcObject = stream(replacement);
      const replaced = await page.run("pull");
      expect(replaced.base64).toBe("");
      expect(page.connected).toEqual(new Set([replacement]));
      page.processAudio(new Float32Array([0.75]));
      page.state.owner = "session-2";
      const stale = await page.run("pull");
      expect(stale).toEqual({ captureId: "capture-1", closed: true });
      expect(page.connected.size).toBe(0);
      page.processAudio(new Float32Array([1]));
      expect((await page.run("pull")).closed).toBe(true);
    });

    it.each([
      ["same-source", false, true],
      ["replacement-stream", false, true],
      ["replacement-track", false, true],
      ["replacement-session", false, true],
      ["same-source", false, false],
      ["replacement-stream", true, true],
      ["replacement-session", true, true],
    ] as const)(
      "restores only owned media (%s, detached=%s, scanned=%s)",
      async (transition, detached, scanned) => {
        page.remoteTrack.readyState = "ended";
        if (scanned) {
          await page.run("pull");
          expect(page.status()).toMatchObject({ remote: true, tracks: [] });
        }
        if (detached) {
          page.elements.splice(page.elements.indexOf(page.remote), 1);
        }
        if (transition === "replacement-stream") {
          page.remote.srcObject = stream();
        } else if (transition === "replacement-track") {
          const replacement = makeTrack();
          page.remote.srcObject.getAudioTracks = () => [replacement];
        } else if (transition === "replacement-session") {
          page.state.owner = "session-2";
        }
        await page.run(detached ? "pull" : "stop");
        expect(page.remote.muted).toBe(transition !== "same-source");
        if (detached) {
          expect(page.connected.size).toBe(0);
          await page.run("stop");
        }
        expect(page.close).toHaveBeenCalledOnce();
      },
    );

    it.each([false, true])(
      "recaptures a detached source after reinsertion (pending=%s)",
      async (pending) => {
        if (pending) {
          page.remoteTrack.readyState = "ended";
          await page.run("pull");
        }
        page.elements.splice(page.elements.indexOf(page.remote), 1);
        await page.run("pull");
        expect(page.status()).toMatchObject({ remote: false, tracks: [] });
        if (pending) {
          page.remote.srcObject = stream(makeTrack());
        }
        page.elements.push(page.remote);
        await page.run("pull");
        expect(page.status()).toMatchObject({
          remote: true,
          tracks: page.remote.srcObject.getAudioTracks(),
        });
        await page.run("stop");
        expect(page.remote.muted).toBe(false);
      },
    );

    it("restores playback when an owned track is reclassified as microphone input", async () => {
      page.remoteTrack.getSettings = () => ({ deviceId: "virtual-microphone" });
      await page.run("pull");
      expect(page.status()).toMatchObject({ remote: false, tracks: [] });
      await page.run("stop");
    });
  });

  it.each([false, true])(
    "releases retired playback bridges without changing replacement sources (replaced=%s)",
    async (replaced) => {
      const page = createPage();
      const bridge = { srcObject: page.remote.srcObject, muted: false };
      page.elements.push(bridge);
      page.bridges.push({
        sessionId: "session-1",
        bridge,
        source: page.remote,
        sourceMuted: false,
        stream: page.remote.srcObject,
      });
      await page.run("start");
      expect(bridge.muted).toBe(true);
      page.bridges.length = 0;
      page.elements.splice(page.elements.indexOf(bridge), 1);
      if (replaced) {
        bridge.srcObject = stream();
      }
      await page.run("pull");
      expect(bridge.muted).toBe(replaced);
      expect(page.remote.muted).toBe(true);
      await page.run("stop");
    },
  );
});
