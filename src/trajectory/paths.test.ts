import { describe, expect, it } from "vitest";
import {
  resolveTrajectoryRuntimeEventMaxBytes,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
} from "./paths.js";

describe("resolveTrajectoryRuntimeEventMaxBytes", () => {
  const DEFAULT_BYTES = 256 * 1024;

  it("returns the 256 KiB default when env is empty", () => {
    expect(resolveTrajectoryRuntimeEventMaxBytes({})).toBe(DEFAULT_BYTES);
  });

  it("returns the default when the override is whitespace only", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "   ",
      }),
    ).toBe(DEFAULT_BYTES);
  });

  it("accepts raw byte counts", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "1024",
      }),
    ).toBe(1024);
  });

  it("accepts kb suffixes", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "512kb",
      }),
    ).toBe(512 * 1024);
  });

  it("accepts mb suffixes", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "2mb",
      }),
    ).toBe(2 * 1024 * 1024);
  });

  it("accepts gb suffixes", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "1gb",
      }),
    ).toBe(1 * 1024 * 1024 * 1024);
  });

  it("falls back to the default on unparseable input", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "not-a-size",
      }),
    ).toBe(DEFAULT_BYTES);
  });

  it("falls back to the default on non-positive input", () => {
    expect(
      resolveTrajectoryRuntimeEventMaxBytes({
        OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "0",
      }),
    ).toBe(DEFAULT_BYTES);
  });

  it("module-load constant matches the empty-env resolver result", () => {
    expect(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES).toBe(resolveTrajectoryRuntimeEventMaxBytes({}));
  });
});
