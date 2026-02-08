import { describe, expect, it, vi } from "vitest";
import { noteLowMemoryWarning } from "./doctor-platform-notes.js";

describe("noteLowMemoryWarning", () => {
  it("warns when total memory is at or below 2 GB", () => {
    const noteFn = vi.fn();
    noteLowMemoryWarning({ totalMemBytes: 2 * 1024 * 1024 * 1024, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Low memory");
    expect(message).toContain("2048 MB");
    expect(message).toContain("swap");
  });

  it("warns for very low memory (512 MB)", () => {
    const noteFn = vi.fn();
    noteLowMemoryWarning({ totalMemBytes: 512 * 1024 * 1024, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message] = noteFn.mock.calls[0] ?? [];
    expect(message).toContain("512 MB");
  });

  it("does not warn when memory exceeds 2 GB", () => {
    const noteFn = vi.fn();
    noteLowMemoryWarning({ totalMemBytes: 4 * 1024 * 1024 * 1024, noteFn });

    expect(noteFn).not.toHaveBeenCalled();
  });
});
