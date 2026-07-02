// Tests safe cwd helpers for deleted launch directories.
import { describe, expect, it, vi } from "vitest";
import { resolveProcessCwdOrFallback, tryProcessCwd } from "./safe-cwd.js";

describe("safe cwd helpers", () => {
  it("returns process.cwd() when it is accessible", () => {
    expect(tryProcessCwd()).toBe(process.cwd());
  });

  it("returns null when process.cwd() throws", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
        code: "ENOENT",
      });
    });

    try {
      expect(tryProcessCwd()).toBeNull();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("returns the fallback when process.cwd() throws", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
        code: "ENOENT",
      });
    });

    try {
      expect(resolveProcessCwdOrFallback("/fallback")).toBe("/fallback");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("returns process.cwd() over the fallback when cwd is accessible", () => {
    expect(resolveProcessCwdOrFallback("/should/not/be/used")).toBe(process.cwd());
  });
});
