// @vitest-environment node
import { expect, it } from "vitest";
import {
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";

const cloudSelection = { os: "windows/wsl2", machineClass: "tiny" };
const device = { kind: "device", deviceId: "runner" } as const;
const profile = { kind: "profile", profileId: "aws", ...cloudSelection } as const;
const recovered = { kind: "profile", profileId: "aws" } as const;

it.each([
  {
    name: "recovered classless profile",
    sessionKey: "agent:main:pending",
    target: recovered,
    place: { cloudProfileId: "aws", cloudSelection: { os: "linux", machineClass: "small" } },
  },
  { name: "selected device", target: device, place: { deviceId: "runner" } },
  {
    name: "profile",
    target: profile,
    place: { cloudProfileId: "aws", cloudSelection },
  },
  { name: "automatic device", target: { kind: "auto-device" }, place: { autoDevice: true } },
])("retains $name in the draft placement target", ({ sessionKey = "", target, place }) => {
  expect(
    resolveDraftSessionPlacement(
      { sessionKey, target: sessionKey ? recovered : null },
      {
        cloudProfileId: "",
        deviceId: "",
        autoDevice: false,
        cloudSelection: { os: "", machineClass: "" },
        ...place,
      },
    ),
  ).toEqual(target);
});

const recovery = {
  sessionKey: "agent:main:cloud",
  messageId: "message-cloud",
  message: "continue in the cloud",
  agentId: "main",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
};
const createParams = { key: recovery.sessionKey, agentId: "main", message: "" } as const;
const repository = { url: "https://github.com/openclaw/openclaw.git", ref: "release/next" };

it.each([
  {
    name: "dispatching device",
    target: device,
    phase: "dispatching",
    message: "continue on the runner",
    createParams: undefined,
    expected: {
      placement: { agentId: "main", profileId: "", deviceId: "runner" },
      draft: { message: "continue on the runner" },
    },
  },
  {
    name: "creating empty workspace",
    target: profile,
    phase: "creating",
    message: recovery.message,
    createParams: {
      ...createParams,
      permissionMode: "guarded",
      visibility: "draft",
      toolOverrides: { skills: { release: false } },
      worktree: true,
      worktreeSource: "empty",
    },
    expected: {
      placement: { profileId: "aws", ...cloudSelection, worktreeSource: "empty" },
      draft: {
        permissionMode: "guarded",
        visibility: "draft",
        toolOverrides: { skills: { release: false } },
      },
    },
  },
  {
    name: "creating repository without Gateway folder",
    target: { kind: "profile", profileId: "cloud" },
    phase: "creating",
    message: "Run remotely",
    createParams: { ...createParams, repository },
    expected: { placement: { repository, cwd: undefined }, draft: { message: "Run remotely" } },
  },
] as const)("restores $name", ({ expected, ...input }) => {
  expect(projectDraftSessionPlacementRecovery({ ...recovery, ...input })).toMatchObject(expected);
});
