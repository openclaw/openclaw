import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeControlUiBuildInfo } from "./build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "./build-info-types.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
function expectInfo(input: unknown, expected: Partial<ControlUiBuildInfo>) {
  expect(normalizeControlUiBuildInfo(input)).toMatchObject(expected);
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Control UI build info", () => {
  it("compares the normalized embedded version with the gateway", async () => {
    const injectedBuildInfo = normalizeControlUiBuildInfo({
      version: "2026.7.19",
      commit: COMMIT,
      buildId: "test",
    });
    vi.stubGlobal("OPENCLAW_CONTROL_UI_BUILD_INFO", injectedBuildInfo);
    vi.resetModules();

    const { CONTROL_UI_BUILD_INFO, controlUiBuildDiffersFrom } = await import("./build-info.ts");
    expect(CONTROL_UI_BUILD_INFO).toBe(injectedBuildInfo);
    expect(controlUiBuildDiffersFrom({ version: " 2026.7.19 " })).toBe(false);
    expect(controlUiBuildDiffersFrom({ version: "2026.7.20" })).toBe(true);
    expect(controlUiBuildDiffersFrom({ version: undefined })).toBe(false);
    expect(controlUiBuildDiffersFrom({ version: "2026.7.19", buildId: "test" })).toBe(false);
    expect(controlUiBuildDiffersFrom({ version: "2026.7.19", buildId: "other" })).toBe(true);
    expect(
      controlUiBuildDiffersFrom({
        version: "2026.7.20",
        buildId: "other",
        controlUiBuildSource: "configured",
      }),
    ).toBe(false);
  });

  it("normalizes the fallback when no build info is injected", async () => {
    vi.stubGlobal("OPENCLAW_CONTROL_UI_BUILD_INFO", undefined);
    vi.resetModules();

    const { CONTROL_UI_BUILD_INFO } = await import("./build-info.ts");
    expect(CONTROL_UI_BUILD_INFO).toEqual(normalizeControlUiBuildInfo(undefined));
  });

  it("normalizes advisory branch identity", () => {
    for (const [branch, expected] of [
      ["  feature/build-chip  ", "feature/build-chip"],
      ["HEAD", null],
      [" ", null],
      ["x".repeat(101), "x".repeat(100)],
      [`${"x".repeat(98)}😀tail`, `${"x".repeat(98)}😀`],
      [`${"x".repeat(99)}😀tail`, "x".repeat(99)],
    ]) {
      expect(normalizeControlUiBuildInfo({ branch }).branch).toBe(expected);
    }
  });

  it("canonicalizes only valid UTC build timestamps", () => {
    for (const [builtAt, expected] of [
      ["2026-07-10T12:34:56Z", "2026-07-10T12:34:56.000Z"],
      ["2026-07-10T12:34:56.123Z", "2026-07-10T12:34:56.123Z"],
      ["2026-07-10T12:34:56.7Z", "2026-07-10T12:34:56.700Z"],
      ["2026-07-10T12:34:56.12Z", "2026-07-10T12:34:56.120Z"],
      ["2026-02-30T12:34:56Z", null],
      ["2026-07-10T12:34:56+00:00", null],
    ]) {
      expect(normalizeControlUiBuildInfo({ builtAt }).builtAt).toBe(expected);
    }
    expectInfo({ commitAt: "2026-07-10T11:22:33Z" }, { commitAt: "2026-07-10T11:22:33.000Z" });
    expectInfo({ commitAt: "2026-07-10T11:22:33+02:00" }, { commitAt: null });
  });

  it("passes through normalized branch, dirty state, and release identity", () => {
    expectInfo(
      { branch: " feature/x ", dirty: false, release: true },
      { branch: "feature/x", dirty: false, release: true },
    );
  });

  it("derives a stable service-worker id from the same artifact metadata", () => {
    expectInfo(
      {
        version: "2026.7.10",
        commit: COMMIT,
        builtAt: "2026-07-10T12:34:56.000Z",
        release: true,
      },
      { buildId: "2026.7.10-release-0123456789ab-2026-07-10T12-34-56.000Z" },
    );
  });
});
