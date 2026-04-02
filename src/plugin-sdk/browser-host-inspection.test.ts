import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBrowserMajorVersion,
  resolveGoogleChromeExecutableForPlatform,
} from "./browser-host-inspection.js";

describe("browser host inspection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the last dotted browser version token", () => {
    expect(parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
    expect(parseBrowserMajorVersion("Chromium 3.0/1.2.3")).toBe(1);
    expect(parseBrowserMajorVersion("no version here")).toBeNull();
  });

  it("classifies beta Linux Chrome builds as prerelease", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const normalized = String(candidate);
      return normalized === "/usr/bin/google-chrome-beta";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
  });

  it("classifies unstable Linux Chrome builds as prerelease", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const normalized = String(candidate);
      return normalized === "/usr/bin/google-chrome-unstable";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-unstable",
    });
  });
});
