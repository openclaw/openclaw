import { describe, expect, it, vi } from "vitest";
import { fireAndForgetHook } from "./fire-and-forget.js";

describe("fireAndForgetHook", () => {
  it("logs rejection errors", async () => {
    const logger = vi.fn();
    fireAndForgetHook(Promise.reject(new Error("boom")), "hook failed", logger);
    await Promise.resolve();
    expect(logger).toHaveBeenCalledWith("hook failed: Error: boom");
  });

  it("does not log for resolved tasks", async () => {
    const logger = vi.fn();
    fireAndForgetHook(Promise.resolve("ok"), "hook failed", logger);
    await Promise.resolve();
    expect(logger).not.toHaveBeenCalled();
  });
});
