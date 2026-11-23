import path from "node:path";
import { expect, it } from "vitest";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

it("preserves the selected profile when capturing default storage routing", () => {
  const home = path.resolve("synthetic-profile-home");
  expect(
    captureSessionTranscriptStorageEnvironment({
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_PROFILE: "named-profile",
    }),
  ).toEqual({ OPENCLAW_STATE_DIR: path.join(home, ".openclaw-named-profile") });
});

it.each([
  ["linux", "OPENCLAW_STATE_DIR"],
  ["win32", "OPENCLAW_STATE_DIR"],
  ["win32", "openclaw_state_dir"],
] as const)("captures storage facts without reading unrelated values (%s, %s)", (platform, key) => {
  const stateDir = path.resolve("synthetic-state");
  const source: NodeJS.ProcessEnv = {
    openclaw_state_dir: path.resolve("decoy-state"),
    [key]: stateDir,
    OpenClaw_Supervisor_Mode: "external",
  };
  Object.defineProperty(source, "UNRELATED_VALUE", {
    enumerable: true,
    get() {
      throw new Error("Storage capture must not read unrelated environment values");
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    expect(structuredClone(captureSessionTranscriptStorageEnvironment(source))).toEqual({
      OPENCLAW_STATE_DIR: stateDir,
      ...(platform === "win32" ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
