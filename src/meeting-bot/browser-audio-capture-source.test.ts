import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createMeetingBrowserAudioCaptureSource } from "./browser-audio-capture-source.js";

function createPage(devices?: Promise<{ kind: string; deviceId: string; groupId: string }[]>) {
  const localTrack = {
    readyState: "live",
    getSettings: () => ({ deviceId: "virtual-microphone" }),
  };
  const remoteTrack = {
    readyState: "live",
    getSettings: (): { deviceId?: string } => ({ deviceId: "remote-track-id" }),
  };
  const local = { srcObject: { getAudioTracks: () => [localTrack] }, muted: false };
  const remote = { srcObject: { getAudioTracks: () => [remoteTrack] }, muted: false };
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
    createMediaStreamSource(stream: { tracks: unknown[] }) {
      return {
        connect: () => stream.tracks.forEach((track) => connected.add(track)),
        disconnect: () => stream.tracks.forEach((track) => connected.delete(track)),
      };
    }
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
          devices ?? [
            { kind: "audioinput", deviceId: "virtual-microphone", groupId: "microphone-group" },
          ],
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
    processAudio: (data: Float32Array) =>
      processAudio?.({ inputBuffer: { getChannelData: () => data } }),
  };
}

describe("browser meeting input capture", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects ownership lost while discovering input devices", async () => {
    vi.useFakeTimers();
    const devices = createDeferredCore<{ kind: string; deviceId: string; groupId: string }[]>();
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

  it("isolates playback from device tracks, bounds backlog, and restores the exact source", async () => {
    vi.useFakeTimers();
    const page = createPage();
    await page.run("start");
    expect(page.connected).toEqual(new Set([page.remoteTrack]));
    expect(page.remote.muted).toBe(true);
    expect(page.local.muted).toBe(false);
    for (let frame = 0; frame < 250; frame++) {
      page.processAudio(new Float32Array(512).fill(0.25));
    }
    const result = await page.run("pull");
    const pcm = Buffer.from(result.base64 ?? "", "base64");
    expect(pcm.byteLength).toBeLessThanOrEqual(48_128);
    expect(pcm.readInt16LE()).toBe(8192);
    expect(page.connected.has(page.localTrack)).toBe(false);
    await page.run("stop");
    expect(page.remote.muted).toBe(false);
    expect(page.connected.size).toBe(0);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("retires replaced sources and never returns PCM after browser ownership changes", async () => {
    vi.useFakeTimers();
    const page = createPage();
    await page.run("start");
    page.processAudio(new Float32Array([0.5]));
    page.remote.srcObject = { getAudioTracks: () => [] };
    expect((await page.run("pull")).base64).toBe("");
    expect(page.connected.size).toBe(0);
    const replacement = { readyState: "live", getSettings: () => ({}) };
    page.remote.srcObject = { getAudioTracks: () => [replacement] };
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

  it.each(["same-source", "replacement-stream", "replacement-track", "replacement-session"])(
    "restores a pending mute only while its source and session are still owned (%s)",
    async (transition) => {
      vi.useFakeTimers();
      const page = createPage();
      await page.run("start");
      page.remoteTrack.readyState = "ended";
      await page.run("pull");
      expect(page.connected.size).toBe(0);
      expect(page.remote.muted).toBe(true);
      if (transition === "replacement-stream") {
        page.remote.srcObject = { getAudioTracks: () => [] };
      } else if (transition === "replacement-track") {
        page.remote.srcObject.getAudioTracks = () => [
          { readyState: "live", getSettings: () => ({}) },
        ];
      } else if (transition === "replacement-session") {
        page.state.owner = "session-2";
      }
      await page.run("stop");
      expect(page.remote.muted).toBe(transition !== "same-source");
      expect(page.close).toHaveBeenCalledOnce();
    },
  );

  it("restores an owned ended track even when no scan ran before stop", async () => {
    vi.useFakeTimers();
    const page = createPage();
    await page.run("start");
    page.remoteTrack.readyState = "ended";
    await page.run("stop");
    expect(page.remote.muted).toBe(false);
  });

  it.each([false, true])(
    "recaptures a detached source after reinsertion (pending=%s)",
    async (pending) => {
      vi.useFakeTimers();
      const page = createPage();
      await page.run("start");
      if (pending) {
        page.remoteTrack.readyState = "ended";
        await page.run("pull");
      }
      page.elements.splice(page.elements.indexOf(page.remote), 1);
      await page.run("pull");
      expect(page.remote.muted).toBe(false);
      expect(page.connected.size).toBe(0);
      if (pending) {
        const replacementTrack = { readyState: "live", getSettings: () => ({}) };
        page.remote.srcObject = { getAudioTracks: () => [replacementTrack] };
      }
      page.elements.push(page.remote);
      await page.run("pull");
      expect(page.remote.muted).toBe(true);
      expect(page.connected).toEqual(new Set(page.remote.srcObject.getAudioTracks()));
      await page.run("stop");
      expect(page.remote.muted).toBe(false);
    },
  );

  it.each(["replacement-source", "replacement-session"])(
    "leaves detached %s untouched",
    async (transition) => {
      vi.useFakeTimers();
      const page = createPage();
      await page.run("start");
      page.remoteTrack.readyState = "ended";
      await page.run("pull");
      page.elements.splice(page.elements.indexOf(page.remote), 1);
      if (transition === "replacement-source") {
        page.remote.srcObject = { getAudioTracks: () => [] };
      } else {
        page.state.owner = "session-2";
      }
      await page.run("pull");
      expect(page.remote.muted).toBe(true);
      expect(page.connected.size).toBe(0);
      await page.run("stop");
    },
  );

  it("restores playback when an owned track is reclassified as microphone input", async () => {
    vi.useFakeTimers();
    const page = createPage();
    await page.run("start");
    page.remoteTrack.getSettings = () => ({ deviceId: "virtual-microphone" });
    await page.run("pull");
    expect(page.remote.muted).toBe(false);
    expect(page.connected.size).toBe(0);
    await page.run("stop");
  });

  it.each([false, true])(
    "releases retired playback bridges without changing replacement sources (replaced=%s)",
    async (replaced) => {
      vi.useFakeTimers();
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
        bridge.srcObject = { getAudioTracks: () => [] };
      }
      await page.run("pull");
      expect(bridge.muted).toBe(replaced);
      expect(page.remote.muted).toBe(true);
      await page.run("stop");
    },
  );
});
