import { describe, it, expect, afterEach } from "vitest";
import { detectTccError } from "./tcc-detect.js";

describe("detectTccError", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function setDarwin() {
    Object.defineProperty(process, "platform", { value: "darwin" });
  }

  function setLinux() {
    Object.defineProperty(process, "platform", { value: "linux" });
  }

  it("returns null on non-darwin", () => {
    setLinux();
    expect(detectTccError("osascript is not allowed assistive access", 1)).toBeNull();
  });

  it("returns null on empty output", () => {
    setDarwin();
    expect(detectTccError("", 1)).toBeNull();
  });

  it("returns null on exit code 0", () => {
    setDarwin();
    expect(detectTccError("osascript is not allowed assistive access", 0)).toBeNull();
  });

  it("detects accessibility error", () => {
    setDarwin();
    const output = "System Events got an error: osascript is not allowed assistive access.";
    const hint = detectTccError(output, 1);
    expect(hint).toContain("macOS permission error detected");
    expect(hint).toContain("accessibility");
    expect(hint).toContain("permctl.sh");
  });

  it("detects screen recording error", () => {
    setDarwin();
    const output = "screen recording permission is required";
    const hint = detectTccError(output, 1);
    expect(hint).toContain("screen-recording");
  });

  it("detects automation error", () => {
    setDarwin();
    const output = "Not authorized to send Apple events to Finder.";
    const hint = detectTccError(output, 1);
    expect(hint).toContain("automation");
  });

  it("detects full disk access error", () => {
    setDarwin();
    const output = "ls: /Users/test/Library/Mail: Operation not permitted";
    const hint = detectTccError(output, 1);
    expect(hint).toContain("macOS permission error detected");
  });

  it("ignores generic EPERM unrelated to TCC", () => {
    setDarwin();
    expect(detectTccError("chown: /tmp/foo: Operation not permitted", 1)).toBeNull();
    expect(detectTccError("bind: Operation not permitted", 1)).toBeNull();
  });

  it("detects kTCCService pattern", () => {
    setDarwin();
    const output = "tccd deny kTCCServiceCamera for pid 1234";
    const hint = detectTccError(output, 1);
    expect(hint).toContain("camera");
  });

  it("returns null for normal errors", () => {
    setDarwin();
    expect(detectTccError("command not found: foo", 127)).toBeNull();
    expect(detectTccError("segmentation fault", 139)).toBeNull();
    expect(detectTccError("No such file or directory", 1)).toBeNull();
  });
});
