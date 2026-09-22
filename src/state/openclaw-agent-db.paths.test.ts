import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function expectedPath(root: string, agentId = "worker"): string {
  return path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

describe("agent SQLite path memoization", () => {
  it("follows changes to the same environment without crossing agent roots", () => {
    const root = tempDirs.make("openclaw-agent-paths-");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "first") };
    for (const dir of ["first", "second", "first"]) {
      env.OPENCLAW_STATE_DIR = path.join(root, dir);
      for (const agentId of ["Worker", "other", "Worker"]) {
        expect(resolveOpenClawAgentSqlitePath({ agentId, env })).toBe(
          expectedPath(env.OPENCLAW_STATE_DIR, agentId.toLowerCase()),
        );
      }
      expect(resolveIncognitoOpenClawAgentSqlitePath({ agentId: "Worker", env })).toBe(
        path.join(
          env.OPENCLAW_STATE_DIR,
          "agents",
          "worker",
          "agent",
          "incognito-openclaw-agent.sqlite",
        ),
      );
    }
  });

  it("rechecks legacy discovery and home changes after warming paths", () => {
    const root = tempDirs.make("openclaw-agent-path-home-");
    const env = { HOME: path.join(root, "first") };
    const legacy = path.join(env.HOME, ".clawdbot");
    fs.mkdirSync(legacy, { recursive: true });
    expect(resolveOpenClawAgentSqlitePath({ agentId: "worker", env })).toBe(expectedPath(legacy));
    const current = path.join(env.HOME, ".openclaw");
    fs.mkdirSync(current);
    expect(resolveOpenClawAgentSqlitePath({ agentId: "worker", env })).toBe(expectedPath(current));
    env.HOME = path.join(root, "second");
    expect(resolveOpenClawAgentSqlitePath({ agentId: "worker", env })).toBe(
      expectedPath(path.join(env.HOME, ".openclaw")),
    );
  });

  it("resolves relative overrides and explicit paths against the current cwd", () => {
    const root = tempDirs.make("openclaw-agent-path-cwd-");
    const cwd = vi.spyOn(process, "cwd");
    const env = { OPENCLAW_STATE_DIR: "relative-state" };
    for (const dir of ["first", "second", "first"]) {
      const workingDir = path.join(root, dir);
      cwd.mockReturnValue(workingDir);
      expect(resolveOpenClawAgentSqlitePath({ agentId: "worker", env })).toBe(
        expectedPath(path.join(workingDir, "relative-state")),
      );
      expect(
        resolveOpenClawAgentSqlitePath({ agentId: "worker", env, path: "custom.sqlite" }),
      ).toBe(path.join(workingDir, "custom.sqlite"));
    }
  });
});
