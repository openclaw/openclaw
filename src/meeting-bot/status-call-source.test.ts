import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createMeetingStatusCallSource } from "./status-call-source.js";
import { createMeetingStatusPreludeSource } from "./status-prejoin-source.js";

const platform = {
  audioOutputElementIdPrefix: "test-output-",
  displayName: "Test meeting",
  globals: {
    audioOutputs: "testAudioOutputs",
    captionArchive: "__testCaptionArchive",
    captions: "__testCaptions",
    meeting: "__testMeeting",
  },
  manualActionReasonPrefix: "test",
};

function routingFixture(extraOptions: { afterAudioRoutingSource?: string } = {}) {
  let owned = true;
  const effectsAfterLoss: string[] = [];
  const recordEffect = (effect: string) => {
    if (!owned) {
      effectsAfterLoss.push(effect);
    }
  };
  const mediaElement = () => {
    let muted = false;
    return {
      id: "",
      sinkId: "physical-out",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      isConnected: true,
      get muted() {
        return muted;
      },
      set muted(value: boolean) {
        if (value) {
          recordEffect("mute");
        }
        muted = value;
      },
      setSinkId: vi.fn(async function (this: { sinkId: string }, sinkId: string) {
        // Returning playback to the physical output is the undo, not a new routing effect.
        recordEffect(sinkId === "physical-out" ? "restore-sink" : "setSinkId");
        this.sinkId = sinkId;
      }),
      play: vi.fn(async () => recordEffect("play")),
      pause: vi.fn(),
      remove: vi.fn(),
    };
  };
  const first = mediaElement();
  const second = mediaElement();
  const bridge = mediaElement();
  const media = [first, second];
  const foreign = { sessionId: "other-session", bridge: mediaElement() };
  const previousSource = mediaElement();
  previousSource.muted = true;
  const previousBridge = mediaElement();
  const window = {
    testAudioOutputs: [
      foreign,
      {
        sessionId: "session-1",
        source: previousSource,
        sourceMuted: false,
        stream: previousSource.srcObject,
        bridge: previousBridge,
      },
    ],
  };
  const enumerateDevices = vi.fn(async () => [
    { kind: "audiooutput", label: "BlackHole 2ch", deviceId: "virtual-out" },
  ]);
  const options = {
    platform,
    captionEnableSource: "",
    liveOwnershipSource: "ownsCall()",
    ...extraOptions,
  };
  const prelude = createMeetingStatusPreludeSource(
    {
      allowMicrophone: true,
      allowSessionAdoption: false,
      autoJoin: false,
      captureCaptions: false,
      expectedIdentity: "test:meeting",
      guestName: "OpenClaw",
      meetingSessionId: "session-1",
      pageIdentitySource: 'const meetingIdentity = () => "test:meeting";',
      selectors: "{}",
      toggleStateFunction: "() => undefined",
      waitForInCallMs: 30_000,
    },
    {
      platform,
      controlLookupSource: "",
      lifecycleSource: `
        const { isVirtualAudioDevice } = meetingAudioInput;
        const inCall = true, identityVerified = true, identityAwaitingRerender = false;
        const microphoneState = "on", cameraState = "off";
        const continueInBrowser = undefined, clickedJoin = false, lobbyWaiting = false;
        const audioInputRouted = true, audioInputDeviceLabel = undefined, audioInputRouteError = undefined;
        let manualAction;`,
      manualActionSource: "",
    },
  );
  return {
    first,
    second,
    bridge,
    media,
    window,
    foreign,
    previousSource,
    previousBridge,
    effectsAfterLoss,
    enumerateDevices,
    loseOwnership: () => {
      owned = false;
    },
    regainOwnership: () => {
      owned = true;
    },
    async status() {
      return JSON.parse(
        await runInNewContext(`(${prelude}${createMeetingStatusCallSource(options)})()`, {
          window,
          location: { href: "https://example.test/meeting" },
          navigator: { mediaDevices: { enumerateDevices } },
          ownsCall: () => owned,
          afterRouting: async () => {
            owned = false;
          },
          document: {
            title: "Test meeting",
            querySelectorAll: () => media,
            createElement: () => bridge,
            body: { appendChild: vi.fn() },
          },
        }),
      );
    },
  };
}

describe("meeting status live ownership", () => {
  it.each([true, false])(
    "stops routing when ownership ends during enumerateDevices (media present: %s)",
    async (mediaPresent) => {
      const fixture = routingFixture();
      if (!mediaPresent) {
        fixture.media.length = 0;
      }
      fixture.enumerateDevices.mockImplementationOnce(async () => {
        fixture.loseOwnership();
        return [{ kind: "audiooutput", label: "BlackHole 2ch", deviceId: "virtual-out" }];
      });

      const result = await fixture.status();
      expect(fixture.previousSource.muted).toBe(false);
      expect(fixture.previousBridge.pause).toHaveBeenCalled();
      expect(fixture.previousBridge.srcObject).toBeNull();
      expect(result).toMatchObject({
        audioOutputRouted: false,
        audioOutputRouteRetryable: true,
        notes: expect.arrayContaining([expect.stringContaining("ownership")]),
      });
      expect(fixture.effectsAfterLoss).toEqual([]);
      expect(fixture.first.setSinkId).not.toHaveBeenCalled();
      expect(fixture.first.muted).toBe(false);
      expect(fixture.window.testAudioOutputs).toEqual([fixture.foreign]);
      expect(fixture.foreign.bridge.pause).not.toHaveBeenCalled();
    },
  );

  it("rolls back this pass when ownership ends inside the after-routing hook", async () => {
    const fixture = routingFixture({ afterAudioRoutingSource: "await afterRouting();" });
    expect(await fixture.status()).toMatchObject({
      audioOutputRouted: false,
      notes: expect.arrayContaining([expect.stringContaining("ownership")]),
    });
    await Promise.resolve();
    expect(fixture.first.sinkId).toBe("physical-out");
    expect(fixture.first.muted).toBe(false);
  });

  it("leaves media alone when another session takes over during routing", async () => {
    const fixture = routingFixture();
    fixture.first.setSinkId.mockImplementationOnce(async function (
      this: { sinkId: string },
      sinkId: string,
    ) {
      this.sinkId = sinkId;
      fixture.loseOwnership();
      Object.assign(fixture.window, { __testMeeting: { sessionId: "session-2" } });
    });
    expect(await fixture.status()).toMatchObject({ audioOutputRouted: false });
    expect(fixture.first.sinkId).toBe("virtual-out");
    expect(fixture.first.muted).toBe(true);
  });

  it("finishes an earlier sink restore before routing again", async () => {
    const fixture = routingFixture();
    let finishRestore: () => void = () => {};
    fixture.first.setSinkId.mockImplementation(async function (
      this: { sinkId: string },
      sinkId: string,
    ) {
      if (sinkId === "physical-out") {
        await new Promise<void>((resolve) => {
          finishRestore = resolve;
        });
      } else {
        fixture.loseOwnership();
      }
      this.sinkId = sinkId;
    });
    await fixture.status();
    fixture.regainOwnership();
    let secondDone = false;
    const second = fixture.status().then(() => {
      secondDone = true;
    });
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
    expect(secondDone).toBe(false);
    finishRestore();
    await second;
    expect(secondDone).toBe(true);
  });

  it("makes overlapping passes all wait for an in-flight sink restore", async () => {
    const fixture = routingFixture();
    let finishRestore: () => void = () => {};
    fixture.first.setSinkId.mockImplementation(async function (
      this: { sinkId: string },
      sinkId: string,
    ) {
      if (sinkId === "physical-out") {
        await new Promise<void>((resolve) => {
          finishRestore = resolve;
        });
      } else {
        fixture.loseOwnership();
      }
      this.sinkId = sinkId;
    });
    await fixture.status();
    fixture.regainOwnership();
    const done = [false, false];
    const passes = [0, 1].map((index) =>
      fixture.status().then(() => {
        done[index] = true;
      }),
    );
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
    expect(done).toEqual([false, false]);
    finishRestore();
    await Promise.all(passes);
    expect(done).toEqual([true, true]);
  });

  it("returns a completed direct sink change to its original output when ownership ends", async () => {
    const fixture = routingFixture();
    fixture.first.setSinkId.mockImplementationOnce(async function (
      this: { sinkId: string },
      sinkId: string,
    ) {
      this.sinkId = sinkId;
      fixture.loseOwnership();
    });
    expect(await fixture.status()).toMatchObject({ audioOutputRouted: false });
    await Promise.resolve();
    expect(fixture.first.sinkId).toBe("physical-out");
    expect(fixture.first.muted).toBe(false);
    expect(fixture.second.setSinkId).not.toHaveBeenCalled();
  });

  it.each([
    "direct sink",
    "rejected direct sink",
    "bridge sink",
    "bridge play",
    "rejected bridge play",
  ])("undoes this pass and stops media effects when ownership ends during %s", async (boundary) => {
    const fixture = routingFixture();
    const loseOwnership = async () => {
      expect(fixture.first.muted).toBe(true);
      expect(fixture.second.muted).toBe(true);
      fixture.loseOwnership();
      if (boundary.startsWith("rejected")) {
        throw new Error("Device changed");
      }
    };
    if (boundary.includes("direct")) {
      fixture.first.setSinkId.mockImplementationOnce(loseOwnership);
    } else {
      fixture.first.setSinkId.mockRejectedValueOnce(new Error("Direct routing unavailable"));
      if (boundary === "bridge sink") {
        fixture.bridge.setSinkId.mockImplementationOnce(loseOwnership);
      } else {
        fixture.bridge.play.mockImplementationOnce(loseOwnership);
      }
    }

    expect(await fixture.status()).toMatchObject({
      audioOutputRouted: false,
      audioOutputRouteRetryable: true,
      notes: expect.arrayContaining([expect.stringContaining("ownership")]),
    });
    expect(fixture.effectsAfterLoss.filter((effect) => effect !== "restore-sink")).toEqual([]);
    expect(fixture.second.setSinkId).not.toHaveBeenCalled();
    expect(fixture.first.muted).toBe(false);
    expect(fixture.second.muted).toBe(false);
    if (boundary.includes("bridge")) {
      expect(fixture.bridge.pause).toHaveBeenCalled();
      expect(fixture.bridge.srcObject).toBeNull();
      expect(fixture.bridge.remove).toHaveBeenCalled();
    }
    expect(fixture.window.testAudioOutputs).toEqual([fixture.foreign]);
    expect(fixture.foreign.bridge.pause).not.toHaveBeenCalled();
  });
});
