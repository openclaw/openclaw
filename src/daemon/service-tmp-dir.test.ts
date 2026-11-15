import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServiceTmpDir } from "./service-tmp-dir.js";

describe("resolveServiceTmpDir", () => {
  it("does not invent a Linux TMPDIR", () => {
    expect(resolveServiceTmpDir({ HOME: "/home/u" }, "linux")).toBeUndefined();
    expect(resolveServiceTmpDir({ HOME: "/home/u", TMPDIR: "  " }, "linux")).toBeUndefined();
  });

  it("keeps an operator's Linux TMPDIR", () => {
    expect(resolveServiceTmpDir({ HOME: "/home/u", TMPDIR: " /var/tmp " }, "linux")).toBe(
      "/var/tmp",
    );
  });

  it("uses the state directory on macOS", () => {
    expect(
      resolveServiceTmpDir({ HOME: "/Users/u", OPENCLAW_STATE_DIR: "/Users/u/.oc" }, "darwin"),
    ).toBe(path.join("/Users/u/.oc", "tmp"));
  });

  it("keeps the host default on other platforms", () => {
    expect(resolveServiceTmpDir({}, "win32")).toBe(os.tmpdir());
    expect(resolveServiceTmpDir({ TMPDIR: "/scratch" }, "freebsd")).toBe("/scratch");
  });
});
