// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";

describe("new-session placement target", () => {
  it.each([
    {
      place: {
        cloudProfileId: "",
        deviceId: "runner",
        autoDevice: false,
        cloudSelection: { os: "", machineClass: "" },
      },
      target: { kind: "device", deviceId: "runner" },
    },
    {
      place: {
        cloudProfileId: "aws",
        deviceId: "",
        autoDevice: false,
        cloudSelection: { os: "windows/wsl2", machineClass: "tiny" },
      },
      target: { kind: "profile", profileId: "aws", os: "windows/wsl2", machineClass: "tiny" },
    },
  ])("preserves selected placement options for $target.kind", ({ place, target }) => {
    expect(resolveDraftSessionPlacement({ sessionKey: "", target: null }, place).target).toEqual(
      target,
    );
  });

  it("preserves automatic device selection through the draft placement target", () => {
    expect(
      resolveDraftSessionPlacement(
        { sessionKey: "", target: null },
        {
          cloudProfileId: "",
          deviceId: "",
          autoDevice: true,
          cloudSelection: { os: "", machineClass: "" },
        },
      ).target,
    ).toEqual({ kind: "auto-device" });
  });

  it("restores a device recovery into the same draft placement owner", () => {
    expect(
      projectDraftSessionPlacementRecovery({
        sessionKey: "agent:main:device",
        messageId: "message-device",
        message: "continue on the runner",
        target: { kind: "device", deviceId: "runner" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    ).toMatchObject({
      placement: { agentId: "main", profileId: "", deviceId: "runner" },
      draft: { message: "continue on the runner" },
    });
  });

  it("restores draft visibility and capability choices from a creating recovery", () => {
    expect(
      projectDraftSessionPlacementRecovery({
        sessionKey: "agent:main:cloud",
        messageId: "message-cloud",
        message: "continue in the cloud",
        target: { kind: "profile", profileId: "aws", os: "windows/wsl2", machineClass: "tiny" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:main:cloud",
          agentId: "main",
          message: "",
          permissionMode: "guarded",
          visibility: "draft",
          toolOverrides: { skills: { release: false } },
          worktree: true,
        },
      }),
    ).toMatchObject({
      placement: { profileId: "aws", os: "windows/wsl2", machineClass: "tiny" },
      draft: {
        permissionMode: "guarded",
        visibility: "draft",
        toolOverrides: { skills: { release: false } },
      },
    });
  });

  it("restores repository and ref from a creating recovery without a Gateway folder", () => {
    const repository = { url: "https://github.com/openclaw/openclaw.git", ref: "release/next" };
    expect(
      projectDraftSessionPlacementRecovery({
        sessionKey: "agent:main:cloud",
        messageId: "message-cloud",
        message: "Run remotely",
        target: { kind: "profile", profileId: "cloud" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: { key: "agent:main:cloud", agentId: "main", message: "", repository },
      }),
    ).toMatchObject({
      placement: { repository, cwd: undefined },
      draft: { message: "Run remotely" },
    });
  });
});
