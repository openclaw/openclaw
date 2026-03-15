import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHomeDir } from "./paths.js";

describe("resolveHomeDir", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns HOME when available in a normal shell", () => {
    expect(resolveHomeDir({ HOME: "/home/alice" })).toBe("/home/alice");
  });

  it("prefers the sudo caller home when HOME points at root", () => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: 1000,
      gid: 1000,
      username: "alice",
      homedir: "/home/alice",
      shell: "/bin/bash",
    });

    expect(resolveHomeDir({ HOME: "/root", SUDO_USER: "alice" })).toBe("/home/alice");
  });

  it("uses sudo caller home when HOME is missing", () => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: 1001,
      gid: 1001,
      username: "bob",
      homedir: "/home/bob",
      shell: "/bin/bash",
    });

    expect(resolveHomeDir({ SUDO_USER: "bob" })).toBe("/home/bob");
  });

  it("keeps HOME when sudo user lookup fails", () => {
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("lookup failed");
    });

    expect(resolveHomeDir({ HOME: "/root", SUDO_USER: "alice" })).toBe("/root");
  });
});
