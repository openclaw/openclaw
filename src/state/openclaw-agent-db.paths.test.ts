import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUserPathBaseDirectory } from "../infra/home-dir.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function expectedPath(root: string, agentId = "worker"): string {
  return path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

describe("SQLite path memoization", () => {
  it("follows changes to the same environment without crossing agent roots", () => {
    const root = tempDirs.make("openclaw-agent-paths-");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "first") };
    for (const dir of ["first", "second", "first"]) {
      env.OPENCLAW_STATE_DIR = path.join(root, dir);
      expect(resolveOpenClawStateSqlitePath(env)).toBe(
        path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
      );
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
      expect(resolveOpenClawStateSqlitePath(env)).toBe(
        path.join(workingDir, "relative-state", "state", "openclaw.sqlite"),
      );
      expect(
        resolveOpenClawAgentSqlitePath({ agentId: "worker", env, path: "custom.sqlite" }),
      ).toBe(path.join(workingDir, "custom.sqlite"));
    }
  });

  it("reuses path derivations while interleaving pinned roots", () => {
    const root = tempDirs.make("openclaw-path-work-");
    const environments = ["first", "second"].map((name) => ({
      OPENCLAW_STATE_DIR: path.join(root, name),
    }));
    const fixtures = environments.map((env) => ({
      env,
      state: path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
      agent: expectedPath(env.OPENCLAW_STATE_DIR),
    }));
    for (const env of environments) {
      resolveOpenClawStateSqlitePath(env);
      resolveOpenClawAgentSqlitePath({ agentId: "worker", env });
    }
    const resolve = vi.spyOn(path, "resolve");
    const join = vi.spyOn(path, "join");
    for (const fixture of [...fixtures, ...fixtures]) {
      // New env objects must share by input strings, not object identity.
      const env = { ...fixture.env };
      expect(resolveOpenClawStateSqlitePath(env)).toBe(fixture.state);
      expect(resolveOpenClawAgentSqlitePath({ agentId: "worker", env })).toBe(fixture.agent);
    }
    if (process.platform !== "win32") {
      expect(resolve).not.toHaveBeenCalled();
    }
    expect(join).not.toHaveBeenCalled();
  });

  it("keeps home and updater invocation-base changes visible", () => {
    const root = tempDirs.make("openclaw-path-context-");
    for (const name of ["first", "second", "first"]) {
      const home = path.join(root, name);
      for (const env of [
        { HOME: home },
        { OPENCLAW_HOME: home },
        { HOME: home, OPENCLAW_STATE_DIR: "~/.openclaw" },
      ]) {
        expect(resolveOpenClawStateSqlitePath(env)).toBe(
          path.join(home, ".openclaw", "state", "openclaw.sqlite"),
        );
      }
      withUserPathBaseDirectory(home, () => {
        const env = { OPENCLAW_STATE_DIR: "relative-state" };
        expect(resolveOpenClawStateSqlitePath(env)).toBe(
          path.join(home, "relative-state", "state", "openclaw.sqlite"),
        );
        expect(resolveOpenClawAgentSqlitePath({ agentId: "worker", env })).toBe(
          expectedPath(path.join(home, "relative-state")),
        );
      });
    }
  });
});
