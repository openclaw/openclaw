import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createMeetingStatusPreludeSource } from "./status-prejoin-source.js";

describe("meeting status source compatibility", () => {
  const platform = {
    name: "Test meeting",
    token: "test",
    globals: {
      audioOutputs: "__testAudioOutputs",
      captionArchive: "__testCaptionArchive",
      captions: "__testCaptions",
      meeting: "__testMeeting",
    },
  };
  const preludeOptions = {
    controlLookupSource: "const findTextButton = () => undefined;",
    lifecycleSource: ["const microphoneState = undefined;", "const cameraState = undefined;"].join(
      "\n",
    ),
    manualActionSource: "const clickedJoin = false;",
    platform: {
      displayName: platform.name,
      globals: platform.globals,
      manualActionReasonPrefix: platform.token,
    },
  };
  const preludeParams = {
    allowMicrophone: false,
    allowSessionAdoption: false,
    autoJoin: false,
    captureCaptions: false,
    expectedIdentity: `${platform.token}:meeting`,
    guestName: "OpenClaw",
    pageIdentitySource: "const meetingIdentity = () => undefined;",
    selectors: "{}",
    toggleStateFunction: "() => undefined",
    waitForInCallMs: 30_000,
  };

  it("preserves audio helper declarations supplied by released plugin lifecycle fragments", async () => {
    const source = createMeetingStatusPreludeSource(preludeParams, {
      ...preludeOptions,
      // Published plugin fragments declare these names in the generated function's body.
      lifecycleSource: `
        const isVirtualAudioDevice = (value) => value === "plugin device";
        const isVirtualAudioDeviceNode = (node) => isVirtualAudioDevice(node.label);
        const microphoneDeviceRoots = () => ({ control: { label: "plugin device" }, roots: [] });
        const selectedMicrophoneLabel = () => {
          const { control } = microphoneDeviceRoots();
          return isVirtualAudioDeviceNode(control) ? control.label : undefined;
        };
        const microphoneState = "off";
        const cameraState = "off";`,
      manualActionSource: "return selectedMicrophoneLabel();",
    });
    await expect(
      runInNewContext(`(${source}})()`, {
        document: {},
        location: { href: "https://example.test/meeting" },
        window: {},
      }),
    ).resolves.toBe("plugin device");
  });
});
