import { describe, expect, it } from "vitest";
import { shouldSyncSessionsLogic } from "./should-sync-sessions.js";

describe("shouldSyncSessions priority", () => {
  it("returns true for full reindex even when reason is session-start (#44028)", () => {
    // This was the bug: session-start reason returned false BEFORE
    // needsFullReindex could return true, silently dropping session data
    // from the rebuilt index.
    expect(shouldSyncSessionsLogic(true, { reason: "session-start" }, true, false, 0)).toBe(true);
  });

  it("returns true for full reindex even when reason is watch", () => {
    expect(shouldSyncSessionsLogic(true, { reason: "watch" }, true, false, 0)).toBe(true);
  });

  it("returns false for session-start without full reindex", () => {
    expect(shouldSyncSessionsLogic(true, { reason: "session-start" }, false, true, 1)).toBe(false);
  });

  it("returns false for watch without full reindex", () => {
    expect(shouldSyncSessionsLogic(true, { reason: "watch" }, false, true, 1)).toBe(false);
  });

  it("returns false when sessions source is not enabled", () => {
    expect(shouldSyncSessionsLogic(false, { force: true }, true, true, 5)).toBe(false);
  });

  it("returns true when forced", () => {
    expect(shouldSyncSessionsLogic(true, { force: true }, false, false, 0)).toBe(true);
  });

  it("returns true when dirty with pending files and no special reason", () => {
    expect(shouldSyncSessionsLogic(true, { reason: "manual" }, false, true, 3)).toBe(true);
  });

  it("returns false when dirty but no pending files", () => {
    expect(shouldSyncSessionsLogic(true, undefined, false, true, 0)).toBe(false);
  });

  it("returns true when sessionFiles contain non-empty paths", () => {
    expect(shouldSyncSessionsLogic(true, { sessionFiles: ["a.jsonl"] }, false, false, 0)).toBe(
      true,
    );
  });

  it("returns false when sessionFiles are all blank", () => {
    expect(shouldSyncSessionsLogic(true, { sessionFiles: ["", " "] }, false, false, 0)).toBe(false);
  });
});
