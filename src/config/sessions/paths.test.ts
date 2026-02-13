import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLatestSessionTranscriptForAgent,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
  validateSessionId,
} from "./paths.js";

describe("resolveStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const resolved = resolveStorePath("~/.openclaw/agents/{agentId}/sessions/sessions.json", {
      agentId: "research",
    });

    expect(resolved).toBe(
      path.resolve("/srv/openclaw-home/.openclaw/agents/research/sessions/sessions.json"),
    );
  });
});

describe("getLatestSessionTranscriptForAgent", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(path.sep, "tmp", "openclaw-paths-test-"));
    sessionsDir = path.join(tempDir, ".openclaw", "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    vi.stubEnv("OPENCLAW_HOME", tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns null when sessions dir has no jsonl files", async () => {
    const result = await getLatestSessionTranscriptForAgent("main");
    expect(result).toBeNull();
  });

  it("returns null when sessions dir does not exist", async () => {
    const result = await getLatestSessionTranscriptForAgent("other-agent");
    expect(result).toBeNull();
    await fs.mkdir(path.join(tempDir, ".openclaw", "agents", "other-agent", "sessions"), {
      recursive: true,
    });
    const resultAfter = await getLatestSessionTranscriptForAgent("other-agent");
    expect(resultAfter).toBeNull();
  });

  it("returns the most recently modified session file", async () => {
    const older = path.join(sessionsDir, "session-old.jsonl");
    const newer = path.join(sessionsDir, "session-new.jsonl");
    await fs.writeFile(older, '{"type":"session","id":"session-old"}\n', "utf-8");
    await fs.writeFile(newer, '{"type":"session","id":"session-new"}\n', "utf-8");
    const past = Date.now() - 60_000;
    await fs.utimes(older, past / 1000, past / 1000);
    await fs.utimes(newer, Date.now() / 1000, Date.now() / 1000);

    const result = await getLatestSessionTranscriptForAgent("main");

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-new");
    expect(result!.sessionFile).toBe(newer);
  });

  it("derives sessionId from filename stem (topic suffix)", async () => {
    const file = path.join(sessionsDir, "chat-123-topic-abc.jsonl");
    await fs.writeFile(file, '{"type":"session"}\n', "utf-8");

    const result = await getLatestSessionTranscriptForAgent("main");

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("chat-123-topic-abc");
    expect(result!.sessionFile).toBe(file);
  });
});

describe("session path safety", () => {
  it("validates safe session IDs", () => {
    expect(validateSessionId("sess-1")).toBe("sess-1");
    expect(validateSessionId("ABC_123.hello")).toBe("ABC_123.hello");
  });

  it("rejects unsafe session IDs", () => {
    expect(() => validateSessionId("../etc/passwd")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("a/b")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("a\\b")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("/abs")).toThrow(/Invalid session ID/);
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("falls back to sessionId-derived path when sessionFile escapes the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolvedEscaping = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "../../etc/passwd" },
      { sessionsDir },
    );
    expect(resolvedEscaping).toBe(path.resolve(sessionsDir, "sess-1.jsonl"));

    const resolvedAbsolute = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/etc/passwd" },
      { sessionsDir },
    );
    expect(resolvedAbsolute).toBe(path.resolve(sessionsDir, "sess-1.jsonl"));
  });

  it("accepts sessionFile candidates within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "subdir/threaded-session.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "subdir/threaded-session.jsonl"));
  });

  it("accepts absolute sessionFile paths that resolve within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/main/sessions/abc-123.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "abc-123.jsonl"));
  });

  it("accepts absolute sessionFile with topic suffix within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/main/sessions/abc-123-topic-42.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "abc-123-topic-42.jsonl"));
  });

  it("rejects absolute sessionFile paths outside the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath(
        "sess-1",
        { sessionFile: "/tmp/openclaw/agents/work/sessions/abc-123.jsonl" },
        { sessionsDir },
      ),
    ).toThrow(/within sessions directory/);
  });

  it("uses agent sessions dir fallback for transcript path", () => {
    const resolved = resolveSessionTranscriptPath("sess-1", "main");
    expect(resolved.endsWith(path.join("agents", "main", "sessions", "sess-1.jsonl"))).toBe(true);
  });

  it("prefers storePath when resolving session file options", () => {
    const opts = resolveSessionFilePathOptions({
      storePath: "/tmp/custom/agent-store/sessions.json",
      agentId: "ops",
    });
    expect(opts).toEqual({
      sessionsDir: path.resolve("/tmp/custom/agent-store"),
    });
  });

  it("falls back to agentId when storePath is absent", () => {
    const opts = resolveSessionFilePathOptions({ agentId: "ops" });
    expect(opts).toEqual({ agentId: "ops" });
  });
});
