import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempSessionsFixture } from "../config/sessions/test-helpers.js";
import { resolveSessionTranscriptPathInDir } from "../config/sessions/paths.js";
import {
  archiveSessionTranscriptsDetailed,
  resolveSessionTranscriptCandidates,
} from "./session-transcript-files.fs.js";
import { readSessionMessages } from "./session-utils.fs.js";

function hasAssistantTextMessage(
  value: unknown,
): value is { content: Array<{ type: string; text: string }> } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const content = Reflect.get(value, "content");
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return false;
  }
  return (
    typeof Reflect.get(first, "text") === "string" &&
    typeof Reflect.get(first, "type") === "string"
  );
}

describe("session transcript root fallback", () => {
  const fixture = useTempSessionsFixture("session-transcript-files-");
  const sessionId = "12345678-1234-4123-8123-1234567890ab";

  function paths() {
    const sessionsDir = fixture.sessionsDir();
    const agentDir = path.dirname(sessionsDir);
    return {
      storePath: fixture.storePath(),
      sessionsDir,
      agentDir,
      sessionsPath: resolveSessionTranscriptPathInDir(sessionId, sessionsDir),
      rootPath: resolveSessionTranscriptPathInDir(sessionId, agentDir),
    };
  }

  it("includes root fallback for agent store paths", () => {
    const { storePath, sessionsPath, rootPath } = paths();

    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionsPath);

    expect(candidates[0]).toBe(sessionsPath);
    expect(candidates).toContain(rootPath);
    expect(candidates.indexOf(rootPath)).toBeGreaterThan(candidates.indexOf(sessionsPath));
  });

  it("reads messages from root fallback when sessions path is missing", () => {
    const { storePath, sessionsPath, rootPath } = paths();

    fs.writeFileSync(
      rootPath,
      [
        JSON.stringify({ type: "session", id: sessionId }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ROOT_FALLBACK_OK" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const messages = readSessionMessages(sessionId, storePath, sessionsPath);
    const firstMessage = messages[0];

    expect(messages).toHaveLength(1);
    expect(hasAssistantTextMessage(firstMessage)).toBe(true);
    if (!hasAssistantTextMessage(firstMessage)) {
      throw new Error("expected assistant text message");
    }
    expect(firstMessage.content[0]?.text).toBe("ROOT_FALLBACK_OK");
  });

  it("archives the root transcript in the drift case", () => {
    const { storePath, sessionsPath, rootPath } = paths();

    fs.writeFileSync(rootPath, '{"type":"session","id":"' + sessionId + '"}\n', "utf-8");

    const archived = archiveSessionTranscriptsDetailed({
      sessionId,
      storePath,
      sessionFile: sessionsPath,
      reason: "deleted",
    });
    const [archivedEntry] = archived;

    expect(archived).toHaveLength(1);
    expect(archivedEntry?.sourcePath).toBe(rootPath);
    expect(archivedEntry?.archivedPath).toMatch(/\.deleted\./);
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(archivedEntry).toBeDefined();
    if (!archivedEntry) {
      throw new Error("expected archived transcript entry");
    }
    expect(fs.existsSync(archivedEntry.archivedPath)).toBe(true);
  });
});
