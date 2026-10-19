import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-suite-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const withStateDir = <T>(stateDir: string, fn: () => T): T =>
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, fn);

  const sessionPath = (root: string, agent: string, file: string) =>
    path.join(path.resolve(root), "agents", agent, "sessions", file);

  async function createAgentSessionsLayout(label: string) {
    const stateDir = await createCaseDir(label);
    for (const agent of ["main", "bot1", "bot2"]) {
      await fs.mkdir(sessionPath(stateDir, agent, ""), { recursive: true });
    }
    const mainStorePath = sessionPath(stateDir, "main", "sessions.json");
    const bot2SessionPath = sessionPath(stateDir, "bot2", "sess-1.jsonl");
    await Promise.all([mainStorePath, bot2SessionPath].map((file) => fs.writeFile(file, "{}")));
    return { stateDir, mainStorePath, bot2SessionPath };
  }

  it("falls back to unknown when sender missing", () => {
    expect(deriveSessionKey("per-sender", {})).toBe("unknown");
  });

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        provider: "discord",
        groupChannel: "#general",
        space: "friends-of-openclaw",
        id: "123",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-openclaw#general");
  });

  const resolveSessionKeyCases = [
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
  ] as const;
  for (const [scope, ctx, mainKey, expected] of resolveSessionKeyCases) {
    it(`resolves ${scope} context ${JSON.stringify(ctx)}`, () => {
      expect(resolveSessionKey(scope, ctx, mainKey, "main")).toBe(expected);
    });
  }

  it("includes topic ids in session transcript filenames", () => {
    withStateDir("/custom/state", () => {
      expect(resolveSessionTranscriptPath("sess-1", "main", 123)).toBe(
        sessionPath("/custom/state", "main", "sess-1-topic-123.jsonl"),
      );
    });
  });

  it("uses agent id when resolving session file fallback paths", () => {
    withStateDir("/custom/state", () => {
      expect(resolveSessionFilePathCore("sess-2", undefined, { agentId: "codex" })).toBe(
        sessionPath("/custom/state", "codex", "sess-2.jsonl"),
      );
    });
  });

  it.each(["../../etc/passwd", "nested/sess-1.jsonl"])("rejects cross-root %s", (suffix) => {
    withStateDir(path.resolve("/different/state"), () => {
      const sessionFile = resolveSessionFilePathCore(
        "sess-1",
        { sessionFile: sessionPath("/original/state", "bot2", suffix) },
        { agentId: "bot1" },
      );
      expect(sessionFile).toBe(sessionPath("/different/state", "bot1", "sess-1.jsonl"));
    });
  });

  it.each([false, true])("resolves sibling sessions with store options=%s", async (withStore) => {
    const { stateDir, mainStorePath, bot2SessionPath } =
      await createAgentSessionsLayout("sibling-agent");
    const sessionFile = withStateDir(stateDir, () => {
      const opts = withStore
        ? resolveSessionFilePathOptions({ agentId: "bot2", storePath: mainStorePath })
        : { agentId: "bot1" };
      return resolveSessionFilePathCore("sess-1", { sessionFile: bot2SessionPath }, opts);
    });
    expect(await fs.realpath(sessionFile)).toBe(await fs.realpath(bot2SessionPath));
  });
});
