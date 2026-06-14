// Tests safe cwd helpers for deleted launch directories.
import { describe, expect, it, vi } from "vitest";
import { resolveProcessCwdOrFallback, tryProcessCwd } from "./safe-cwd.js";

describe("safe cwd helpers", () => {
  it("returns null when process.cwd throws", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
        code: "ENOENT",
      });
    });

    try {
      expect(tryProcessCwd()).toBeNull();
      expect(resolveProcessCwdOrFallback("/fallback")).toBe("/fallback");
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
