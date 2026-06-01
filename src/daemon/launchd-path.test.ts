import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";

const osState = vi.hoisted(() => ({
  homedir: vi.fn(() => "/actual-home"),
}));

const pathsState = vi.hoisted(() => ({
  behavior: "real" as "real" | "throw-missing-home" | "throw-other",
  otherMessage: "boom",
}));

vi.mock("node:os", () => ({
  default: { homedir: osState.homedir },
  homedir: osState.homedir,
}));

vi.mock("./paths.js", () => ({
  resolveHomeDir: (env: Record<string, string | undefined>) => {
    if (pathsState.behavior === "throw-missing-home") {
      throw new Error("Missing HOME");
    }
    if (pathsState.behavior === "throw-other") {
      throw new Error(pathsState.otherMessage);
    }
    const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
    if (!home) {
      throw new Error("Missing HOME");
    }
    return home;
  },
}));

import { resolveLaunchAgentHomeDir, resolveLaunchAgentPlistPathForLabel } from "./launchd-path.js";

describe("resolveLaunchAgentHomeDir", () => {
  beforeEach(() => {
    osState.homedir.mockReset();
    osState.homedir.mockReturnValue("/actual-home");
    pathsState.behavior = "real";
    pathsState.otherMessage = "boom";
  });

  it("preserves the boot-volume user home when HOME is /Users/<name>", () => {
    expect(resolveLaunchAgentHomeDir({ HOME: "/Users/test" })).toBe("/Users/test");
  });

  it("remaps external APFS HOME to the boot-volume user home", () => {
    expect(
      resolveLaunchAgentHomeDir({ HOME: "/Volumes/MainDataDrive/Users/test", USER: "test" }),
    ).toBe("/Users/test");
  });

  it("falls back to os.homedir() when HOME and USERPROFILE are absent", () => {
    pathsState.behavior = "throw-missing-home";
    osState.homedir.mockReturnValue("/Users/osfallback");
    expect(resolveLaunchAgentHomeDir({})).toBe("/Users/osfallback");
    expect(osState.homedir).toHaveBeenCalledTimes(1);
  });

  it("does not swallow non-Missing-HOME errors from resolveHomeDir", () => {
    pathsState.behavior = "throw-other";
    expect(() => resolveLaunchAgentHomeDir({})).toThrow("boom");
    expect(osState.homedir).not.toHaveBeenCalled();
  });

  it("parses the short name from an external HOME path when USER env is absent", () => {
    expect(resolveLaunchAgentHomeDir({ HOME: "/Volumes/MainDataDrive/Users/test" })).toBe(
      "/Users/test",
    );
  });

  it("prefers the short name parsed from the external HOME path over env.USER", () => {
    expect(
      resolveLaunchAgentHomeDir({ HOME: "/Volumes/MainDataDrive/Users/test", USER: "other" }),
    ).toBe("/Users/test");
  });

  it("rejects short names containing path separators in the HOME path", () => {
    expect(resolveLaunchAgentHomeDir({ HOME: "/Volumes/MainDataDrive/Users/te st" })).toBe(
      "/Volumes/MainDataDrive/Users/te st",
    );
    expect(resolveLaunchAgentHomeDir({ HOME: "/Volumes/MainDataDrive/Users/../etc" })).toBe(
      "/Volumes/MainDataDrive/Users/../etc",
    );
  });

  it("ignores HOME paths that do not end in /Users/<name>", () => {
    expect(resolveLaunchAgentHomeDir({ HOME: "/Volumes/RandomPath" })).toBe("/Volumes/RandomPath");
    expect(resolveLaunchAgentHomeDir({ HOME: "/home/test" })).toBe("/home/test");
    expect(resolveLaunchAgentHomeDir({ HOME: "/Volumes/MainDataDrive/Users/test/SubPath" })).toBe(
      "/Volumes/MainDataDrive/Users/test/SubPath",
    );
  });
});

describe("resolveLaunchAgentPlistPathForLabel", () => {
  beforeEach(() => {
    pathsState.behavior = "real";
  });

  it("returns the boot-volume plist path when HOME is external", () => {
    expect(
      resolveLaunchAgentPlistPathForLabel(
        { HOME: "/Volumes/MainDataDrive/Users/test", USER: "test" },
        "ai.openclaw.gateway",
      ),
    ).toBe("/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist");
  });
});
