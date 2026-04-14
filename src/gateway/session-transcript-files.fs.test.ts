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

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content[0].text).toBe("ROOT_FALLBACK_OK");
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

    expect(archived).toHaveLength(1);
    expect(archived[0]?.sourcePath).toBe(rootPath);
    expect(archived[0]?.archivedPath).toMatch(/\.deleted\./);
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(archived[0]!.archivedPath)).toBe(true);
  });
});
