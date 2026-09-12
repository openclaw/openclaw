import { describe, expect, it } from "vitest";
import { computeCodeWindow } from "./file-preview-window.ts";

describe("computeCodeWindow", () => {
  it("keeps a bounded visible window for large files", () => {
    const window = computeCodeWindow(5000, 0, 660);
    expect(window.start).toBe(0);
    expect(window.end).toBe(60);
    expect(window.topSpacer).toBe(0);
    expect(window.bottomSpacer).toBe(108680);
  });

  it("moves the window with scroll position and clamps its bounds", () => {
    const window = computeCodeWindow(1000, 220000, 660);
    expect(window.start).toBe(970);
    expect(window.end).toBe(1000);
    expect(window.bottomSpacer).toBe(0);
  });
});
