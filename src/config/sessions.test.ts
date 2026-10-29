import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import {
  deriveSessionKey,
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionKey,
  resolveSessionTranscriptPath,
} from "./sessions.js";
import { buildGroupDisplayName } from "./sessions/group-display.js";

describe("sessions", () => {
  const dirs = createSuiteTempRootTracker({ prefix: "openclaw-sessions-suite-" });
  beforeAll(dirs.setup);
  afterAll(dirs.cleanup);

  const sessionPath = (root: string, agent: string, file: string) =>
    path.join(path.resolve(root), "agents", agent, "sessions", file);
  const inState = <T>(fn: () => T, stateDir = "/custom/state") =>
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, fn);

  it("falls back to unknown when sender missing", () => {
    expect(deriveSessionKey("per-sender", {})).toBe("unknown");
  });

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        provider: "discord",
        groupChannel: "#general",
        space: "friends-of-openclaw",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-openclaw#general");
  });

  it.each([
    [
      "per-sender",
      { From: "discord:group:12345", ChatType: "group" },
      "main",
      "agent:main:discord:group:12345",
    ],
    ["global", { From: "+1555" }, undefined, "global"],
    [
      "per-sender",
      { From: "room-123", ChatType: "group", Provider: "demo-chat" },
      "main",
      "agent:main:demo-chat:group:room-123",
    ],
  ] as const)("resolves %s context %j", (scope, ctx, mainKey, expected) => {
    expect(resolveSessionKey(scope, ctx, mainKey, "main")).toBe(expected);
  });

  it("includes topic ids in session transcript filenames", () => {
    inState(() => {
      expect(resolveSessionTranscriptPath("sess-1", "main", 123)).toBe(
        sessionPath("/custom/state", "main", "sess-1-topic-123.jsonl"),
      );
    });
  });

  it("uses agent id when resolving session file fallback paths", () => {
    inState(() => {
      expect(resolveSessionFilePathCore("sess-2", undefined, { agentId: "codex" })).toBe(
        sessionPath("/custom/state", "codex", "sess-2.jsonl"),
      );
    });
  });

  it.each(["../../etc/passwd", "nested/sess-1.jsonl"])("rejects cross-root %s", (suffix) => {
    inState(() => {
      const sessionFile = resolveSessionFilePathCore(
        "sess-1",
        { sessionFile: sessionPath("/original/state", "bot2", suffix) },
        { agentId: "bot1" },
      );
      expect(sessionFile).toBe(sessionPath("/different/state", "bot1", "sess-1.jsonl"));
    }, path.resolve("/different/state"));
  });

  it.each([false, true])("resolves sibling sessions with store options=%s", async (withStore) => {
    const stateDir = await dirs.make("sibling-agent");
    const mainStorePath = sessionPath(stateDir, "main", "sessions.json");
    const bot2SessionPath = sessionPath(stateDir, "bot2", "sess-1.jsonl");
    for (const agent of ["main", "bot1", "bot2"]) {
      await fs.mkdir(sessionPath(stateDir, agent, ""), { recursive: true });
    }
    await fs.writeFile(bot2SessionPath, "{}");
    const sessionFile = inState(() => {
      const opts = withStore
        ? resolveSessionFilePathOptions({ agentId: "bot2", storePath: mainStorePath })
        : { agentId: "bot1" };
      return resolveSessionFilePathCore("sess-1", { sessionFile: bot2SessionPath }, opts);
    }, stateDir);
    expect(await fs.realpath(sessionFile)).toBe(await fs.realpath(bot2SessionPath));
  });
});
