// Workspace default tests cover environment-variable precedence for the
// built-in agent workspace location.
import path from "node:path";
<<<<<<< HEAD
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("uses OPENCLAW_HOME when resolving the default workspace dir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");

    const resolved = withEnv(
      {
        OPENCLAW_WORKSPACE_DIR: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_HOME: home,
        HOME: path.join(path.sep, "home", "other"),
      },
      () => resolveDefaultAgentWorkspaceDir(),
    );

    expect(resolved).toBe(path.join(path.resolve(home), ".openclaw", "workspace"));
=======
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("uses OPENCLAW_HOME when resolving the default workspace dir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    vi.stubEnv("HOME", path.join(path.sep, "home", "other"));

    expect(resolveDefaultAgentWorkspaceDir()).toBe(
      path.join(path.resolve(home), ".openclaw", "workspace"),
    );
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("uses OPENCLAW_WORKSPACE_DIR before OPENCLAW_HOME", () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
<<<<<<< HEAD

    const resolved = withEnv(
      {
        OPENCLAW_WORKSPACE_DIR: workspaceDir,
        OPENCLAW_HOME: path.join(path.sep, "srv", "openclaw-home"),
      },
      () => resolveDefaultAgentWorkspaceDir(),
    );

    expect(resolved).toBe(path.resolve(workspaceDir));
=======
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
    vi.stubEnv("OPENCLAW_HOME", path.join(path.sep, "srv", "openclaw-home"));

    expect(resolveDefaultAgentWorkspaceDir()).toBe(path.resolve(workspaceDir));
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
});
