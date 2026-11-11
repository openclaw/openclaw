import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUserPathBaseDirectory } from "../infra/home-dir.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath as incognitoPath,
  resolveOpenClawAgentSqlitePath as agentPath,
} from "./openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath as statePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function expectedPath(root: string, agentId = "worker"): string {
  return path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function expectPaths(env: NodeJS.ProcessEnv, root: string) {
  expect(statePath(env)).toBe(path.join(root, "state", "openclaw.sqlite"));
  expect(agentPath({ agentId: "worker", env })).toBe(expectedPath(root));
}

it("follows changes to the same environment without crossing agent roots", () => {
  const root = tempDirs.make("openclaw-agent-paths-");
  const env = { OPENCLAW_STATE_DIR: path.join(root, "first") };
  for (const dir of ["first", "second", "first"]) {
    env.OPENCLAW_STATE_DIR = path.join(root, dir);
    expect(statePath(env)).toBe(path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"));
    for (const agentId of ["Worker", "other", "Worker"]) {
      expect(agentPath({ agentId, env })).toBe(
        expectedPath(env.OPENCLAW_STATE_DIR, agentId.toLowerCase()),
      );
    }
    expect(incognitoPath({ agentId: "Worker", env })).toBe(
      path.join(
        path.dirname(expectedPath(env.OPENCLAW_STATE_DIR)),
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
    expectPaths(env, path.join(workingDir, "relative-state"));
    expect(agentPath({ agentId: "worker", env, path: "custom.sqlite" })).toBe(
      path.join(workingDir, "custom.sqlite"),
    );
  }
});

it("keeps home and updater invocation-base changes visible", () => {
  const root = tempDirs.make("openclaw-path-context-");
  for (const name of ["first", "second", "first"]) {
    const home = path.join(root, name);
    expect(statePath({ HOME: home, OPENCLAW_STATE_DIR: "~/.openclaw" })).toBe(
      path.join(home, ".openclaw", "state", "openclaw.sqlite"),
    );
    withUserPathBaseDirectory(home, () => {
      expectPaths({ OPENCLAW_STATE_DIR: "relative-state" }, path.join(home, "relative-state"));
    });
  }
});
