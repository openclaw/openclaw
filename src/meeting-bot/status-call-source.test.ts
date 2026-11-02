import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
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

const devices = [{ kind: "audiooutput", label: "BlackHole 2ch", deviceId: "virtual-out" }];

function routingFixture(afterAudioRoutingSource = "") {
  const effectsAfterLoss: string[] = [];
  const ownership = { current: true };
  const recordEffect = (effect: string) => {
    if (!ownership.current) {
      effectsAfterLoss.push(effect);
    }
  };
  const mediaElement = () => {
    let muted = false;
    return {
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
  const elements = {
    first: mediaElement(),
    second: mediaElement(),
    bridge: mediaElement(),
    previousSource: mediaElement(),
    previousBridge: mediaElement(),
    foreign: { sessionId: "other-session", bridge: mediaElement() },
  };
  const { first, second, bridge, previousSource, previousBridge, foreign } = elements;
  const media = [first, second];
  previousSource.muted = true;
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
  const enumerateDevices = vi.fn(async () => devices);
  const options = {
    platform,
    captionEnableSource: "",
    liveOwnershipSource: "ownsCall()",
    afterAudioRoutingSource,
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
    ...elements,
    media,
    window,
    ownership,
    effectsAfterLoss,
    enumerateDevices,
    async status() {
      return JSON.parse(
        await runInNewContext(`(${prelude}${createMeetingStatusCallSource(options)})()`, {
          window,
          location: { href: "https://example.test/meeting" },
          navigator: { mediaDevices: { enumerateDevices } },
          ownsCall: () => ownership.current,
          afterRouting: async () => {
            ownership.current = false;
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

it.each([
  "enumeration",
  "empty enumeration",
  "routing hook",
  "direct sink",
  "another session",
  "rejected direct sink",
  "bridge sink",
  "bridge play",
  "rejected bridge play",
])("restores only owned playback and stops effects after loss during %s", async (boundary) => {
  const f = routingFixture(boundary === "routing hook" ? "await afterRouting();" : "");
  const enumerating = boundary.includes("enumeration");
  const replaced = boundary === "another session";
  const direct = boundary.includes("direct") || replaced;
  const loseOwnership = async () => {
    if (!enumerating) {
      expect([f.first.muted, f.second.muted]).toEqual([true, true]);
    }
    if (boundary === "direct sink" || replaced) {
      f.first.sinkId = "virtual-out";
    }
    f.ownership.current = false;
    if (replaced) {
      Object.assign(f.window, { __testMeeting: { sessionId: "session-2" } });
    }
    if (boundary.startsWith("rejected")) {
      throw new Error("Device changed");
    }
  };
  if (enumerating) {
    if (boundary === "empty enumeration") {
      f.media.length = 0;
    }
    f.enumerateDevices.mockImplementationOnce(async () => {
      await loseOwnership();
      return devices;
    });
  } else if (direct) {
    f.first.setSinkId.mockImplementationOnce(loseOwnership);
  } else if (boundary !== "routing hook") {
    f.first.setSinkId.mockRejectedValueOnce(new Error("Direct routing unavailable"));
    const effect = boundary === "bridge sink" ? f.bridge.setSinkId : f.bridge.play;
    effect.mockImplementationOnce(loseOwnership);
  }
  expect(await f.status()).toMatchObject({
    audioOutputRouted: false,
    audioOutputRouteRetryable: true,
    notes: expect.arrayContaining([expect.stringContaining("ownership")]),
  });
  await Promise.resolve();
  expect(f.first).toMatchObject({
    sinkId: replaced ? "virtual-out" : "physical-out",
    muted: replaced,
  });
  expect(f.effectsAfterLoss.filter((effect) => effect !== "restore-sink")).toEqual([]);
  expect(f.foreign.bridge.pause).not.toHaveBeenCalled();
  if (boundary !== "routing hook") {
    expect(f.second.setSinkId).not.toHaveBeenCalled();
  }
  if (!replaced) {
    expect(f.second.muted).toBe(false);
    expect(f.window.testAudioOutputs).toEqual([f.foreign]);
  }
  if (enumerating) {
    expect(f.previousSource.muted).toBe(false);
    expect(f.previousBridge.pause).toHaveBeenCalled();
    expect(f.previousBridge.srcObject).toBeNull();
    expect(f.effectsAfterLoss).toEqual([]);
    expect(f.first.setSinkId).not.toHaveBeenCalled();
  }
  if (boundary.includes("bridge")) {
    expect(f.bridge.pause).toHaveBeenCalled();
    expect(f.bridge.srcObject).toBeNull();
    expect(f.bridge.remove).toHaveBeenCalled();
  }
});

it("makes overlapping passes all wait for an in-flight sink restore", async () => {
  const fixture = routingFixture();
  const { promise: restoring, resolve: finishRestore } = createDeferredCore();
  fixture.first.setSinkId.mockImplementation(async (sinkId) => {
    if (sinkId === "physical-out") {
      await restoring;
    } else {
      fixture.ownership.current = false;
    }
    fixture.first.sinkId = sinkId;
  });
  await fixture.status();
  fixture.ownership.current = true;
  const passes = [fixture.status(), fixture.status()].map((pass) => pass.then(() => true));
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
  expect(await Promise.race([...passes, Promise.resolve(false)])).toBe(false);
  finishRestore();
  await expect(Promise.all(passes)).resolves.toEqual([true, true]);
});
