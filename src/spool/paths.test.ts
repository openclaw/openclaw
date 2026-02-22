import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  resolveSpoolDir,
  resolveSpoolEventsDir,
  resolveSpoolDeadLetterDir,
  resolveSpoolEventPath,
  resolveSpoolDeadLetterPath,
} from "./paths.js";

describe("spool paths", () => {
  // Use a platform-appropriate mock home directory
  const mockHome = process.platform === "win32" ? "C:\\Users\\testuser" : "/home/testuser";
  const mockEnv = { HOME: mockHome };

  it("should resolve spool directory under state dir", () => {
    const dir = resolveSpoolDir(mockEnv);
    expect(dir).toBe(path.join(mockHome, ".openclaw", "spool"));
  });

  it("should resolve events directory", () => {
    const dir = resolveSpoolEventsDir(mockEnv);
    expect(dir).toBe(path.join(mockHome, ".openclaw", "spool", "events"));
  });

  it("should resolve dead-letter directory", () => {
    const dir = resolveSpoolDeadLetterDir(mockEnv);
    expect(dir).toBe(path.join(mockHome, ".openclaw", "spool", "dead-letter"));
  });

  it("should resolve event file path", () => {
    const eventPath = resolveSpoolEventPath("test-event-id", mockEnv);
    expect(eventPath).toBe(
      path.join(mockHome, ".openclaw", "spool", "events", "test-event-id.json"),
    );
  });

  it("should resolve dead-letter file path", () => {
    const deadLetterPath = resolveSpoolDeadLetterPath("test-event-id", mockEnv);
    expect(deadLetterPath).toBe(
      path.join(mockHome, ".openclaw", "spool", "dead-letter", "test-event-id.json"),
    );
  });

  it("should respect OPENCLAW_STATE_DIR override", () => {
    const customStateDir =
      process.platform === "win32" ? "C:\\custom\\state\\dir" : "/custom/state/dir";
    const customEnv = {
      HOME: mockHome,
      OPENCLAW_STATE_DIR: customStateDir,
    };
    const dir = resolveSpoolDir(customEnv);
    expect(dir).toBe(path.join(customStateDir, "spool"));
  });

  it("should respect OPENCLAW_PROFILE suffix", () => {
    const profileEnv = {
      HOME: mockHome,
      OPENCLAW_PROFILE: "test",
    };
    const dir = resolveSpoolDir(profileEnv);
    expect(dir).toBe(path.join(mockHome, ".openclaw-test", "spool"));
  });
});
