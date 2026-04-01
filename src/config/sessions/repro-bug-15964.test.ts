import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionFilePath } from "./paths.js";

describe("Bug #15964: non-default agent session path resolution", () => {
  let prevStateDir: string | undefined;

  beforeEach(() => {
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/test-openclaw-state";
  });

  afterEach(() => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
  });

  it("resolves jobhunt agent session with matching sessionsDir", () => {
    const stateDir = "/tmp/test-openclaw-state";
    const jobhuntSessionsDir = path.join(stateDir, "agents", "jobhunt", "sessions");
    const sessionFile = path.join(jobhuntSessionsDir, "test-session-id.jsonl");

    const resolved = resolveSessionFilePath(
      "test-session-id",
      { sessionFile },
      { agentId: "jobhunt", sessionsDir: jobhuntSessionsDir },
    );
    expect(resolved).toBe(sessionFile);
  });

  it("resolves jobhunt agent session with storePath-derived sessionsDir", () => {
    const stateDir = "/tmp/test-openclaw-state";
    const jobhuntSessionsDir = path.join(stateDir, "agents", "jobhunt", "sessions");
    const storePath = path.join(jobhuntSessionsDir, "sessions.json");
    const sessionFile = path.join(jobhuntSessionsDir, "test-session-id.jsonl");

    const resolved = resolveSessionFilePath(
      "test-session-id",
      { sessionFile },
      { agentId: "jobhunt", sessionsDir: path.dirname(storePath) },
    );
    expect(resolved).toBe(sessionFile);
  });

  it("resolves jobhunt session when sessionsDir points to main agent", () => {
    const stateDir = "/tmp/test-openclaw-state";
    const mainSessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const jobhuntSessionFile = path.join(
      stateDir, "agents", "jobhunt", "sessions", "test-session-id.jsonl",
    );

    // This is the key scenario: main agent's sessionsDir but jobhunt's sessionFile
    const resolved = resolveSessionFilePath(
      "test-session-id",
      { sessionFile: jobhuntSessionFile },
      { agentId: "jobhunt", sessionsDir: mainSessionsDir },
    );
    expect(resolved).toBe(jobhuntSessionFile);
  });

  it("resolves session with only agentId (no sessionsDir)", () => {
    const stateDir = "/tmp/test-openclaw-state";
    const expectedPath = path.join(stateDir, "agents", "jobhunt", "sessions", "test-session-id.jsonl");

    const resolved = resolveSessionFilePath(
      "test-session-id",
      undefined,
      { agentId: "jobhunt" },
    );
    expect(resolved).toBe(expectedPath);
  });

  it("handles migration scenario: session file from old state dir", () => {
    const currentStateDir = "/tmp/test-openclaw-state";
    const oldStateDir = "/old/openclaw/state";
    const jobhuntSessionsDir = path.join(currentStateDir, "agents", "jobhunt", "sessions");
    const oldSessionFile = path.join(
      oldStateDir, "agents", "jobhunt", "sessions", "old-session.jsonl",
    );

    // Session was created under old state dir, current env has different state dir
    const resolved = resolveSessionFilePath(
      "old-session",
      { sessionFile: oldSessionFile },
      { agentId: "jobhunt", sessionsDir: jobhuntSessionsDir },
    );
    expect(resolved).toBe(path.resolve(oldSessionFile));
  });
});
