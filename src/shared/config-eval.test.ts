import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasBinary } from "./config-eval.js";

describe("hasBinary", () => {
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    vi.restoreAllMocks();
  });

  it("detects binaries that exist in PATH", () => {
    const accessSync = vi.spyOn(fs, "accessSync");
    accessSync.mockImplementation((target) => {
      if (target === "/tmp/tool") {
        return;
      }
      throw new Error("missing");
    });

    process.env.PATH = "/tmp";
    expect(hasBinary("tool")).toBe(true);
    expect(accessSync).toHaveBeenCalledWith("/tmp/tool", fs.constants.X_OK);
  });

  it("falls back to common install directories when PATH is insufficient", () => {
    if (process.platform === "win32") {
      return;
    }

    const homebrewGh = path.join("/opt/homebrew/bin", "gh");
    const accessSync = vi.spyOn(fs, "accessSync");
    accessSync.mockImplementation((target) => {
      if (target === homebrewGh) {
        return;
      }
      throw new Error("missing");
    });

    process.env.PATH = "/bin";
    expect(hasBinary("gh")).toBe(true);
    expect(accessSync).toHaveBeenCalledWith(homebrewGh, fs.constants.X_OK);
  });
});
