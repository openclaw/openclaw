import path from "node:path";
import { describe, expect, test } from "vitest";
import { rewriteSessionFileForNewSessionId } from "./session-file-rotation.js";

describe("rewriteSessionFileForNewSessionId", () => {
  test("rewrites default generated transcript filenames", () => {
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "old-session.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBe("new-session.jsonl");
  });

  test("rewrites generated transcript filenames while preserving directories", () => {
    const dir = path.join("agents", "main", "sessions");
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: path.join(dir, "old-session.jsonl"),
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBe(path.join(dir, "new-session.jsonl"));
  });

  test("rewrites generated topic transcript filenames", () => {
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "old-session-topic-12345.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBe("new-session-topic-12345.jsonl");
  });

  test("rewrites timestamp-prefixed fork transcript filenames", () => {
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "2026-05-05T02-41-54-761Z_old-session.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBe("2026-05-05T02-41-54-761Z_new-session.jsonl");
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "2026-05-05T02-41-54-761+08-00_old-session.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBe("2026-05-05T02-41-54-761+08-00_new-session.jsonl");
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "2026-05-05T02-41-54-761+08_old-session.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBe("2026-05-05T02-41-54-761+08_new-session.jsonl");
  });

  test("does not rewrite malformed timestamp-looking custom paths", () => {
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "2026-05-05TabcZ_old-session.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBeUndefined();
  });

  test("does not rewrite custom transcript filenames", () => {
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "custom-session.jsonl",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBeUndefined();
  });

  test("does not rewrite empty or non-jsonl paths", () => {
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: " ",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBeUndefined();
    expect(
      rewriteSessionFileForNewSessionId({
        sessionFile: "old-session.txt",
        previousSessionId: "old-session",
        nextSessionId: "new-session",
      }),
    ).toBeUndefined();
  });
});
