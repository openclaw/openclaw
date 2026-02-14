import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

  it("rejects unsafe sessionFile candidates that escape the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "../../etc/passwd" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "/etc/passwd" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);
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

  it("rejects absolute sessionFile paths outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath(
        "sess-1",
        { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
        { sessionsDir },
      ),
    ).toThrow(/within sessions directory/);
  });

  it("uses explicit agentId fallback for absolute sessionFile outside sessionsDir", () => {
    const mainSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "main" }));
    const opsSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "ops" }));
    const opsSessionFile = path.join(opsSessionsDir, "abc-123.jsonl");

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir, agentId: "ops" },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses absolute path fallback when sessionFile includes a different agent dir", () => {
    const mainSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "main" }));
    const opsSessionsDir = path.dirname(resolveStorePath(undefined, { agentId: "ops" }));
    const opsSessionFile = path.join(opsSessionsDir, "abc-123.jsonl");

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses sibling fallback for custom per-agent store roots", () => {
    const mainSessionsDir = "/srv/custom/agents/main/sessions";
    const opsSessionFile = "/srv/custom/agents/ops/sessions/abc-123.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir, agentId: "ops" },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses extracted agent fallback for custom per-agent store roots", () => {
    const mainSessionsDir = "/srv/custom/agents/main/sessions";
    const opsSessionFile = "/srv/custom/agents/ops/sessions/abc-123.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: opsSessionFile },
      { sessionsDir: mainSessionsDir },
    );

    expect(resolved).toBe(path.resolve(opsSessionFile));
  });

  it("uses agent sessions dir fallback for transcript path", () => {
    const resolved = resolveSessionTranscriptPath("sess-1", "main");
    expect(resolved.endsWith(path.join("agents", "main", "sessions", "sess-1.jsonl"))).toBe(true);
  });

  it("keeps storePath and agentId when resolving session file options", () => {
    const opts = resolveSessionFilePathOptions({
      storePath: "/tmp/custom/agent-store/sessions.json",
      agentId: "ops",
    });
    expect(opts).toEqual({
      sessionsDir: path.resolve("/tmp/custom/agent-store"),
      agentId: "ops",
    });
  });

  it("keeps custom per-agent store roots when agentId is provided", () => {
    const opts = resolveSessionFilePathOptions({
      storePath: "/srv/custom/agents/ops/sessions/sessions.json",
      agentId: "ops",
    });
    expect(opts).toEqual({
      sessionsDir: path.resolve("/srv/custom/agents/ops/sessions"),
      agentId: "ops",
    });
  });

  it("falls back to agentId when storePath is absent", () => {
    const opts = resolveSessionFilePathOptions({ agentId: "ops" });
    expect(opts).toEqual({ agentId: "ops" });
  });
});
