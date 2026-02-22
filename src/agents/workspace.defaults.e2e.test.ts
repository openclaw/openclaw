import path from "node:path";
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
  });

  it("uses OPENCLAW_STATE_DIR when resolving the default workspace dir", () => {
    const stateDir = path.join(path.sep, "srv", "openclaw-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    expect(resolveDefaultAgentWorkspaceDir()).toBe(path.join(path.resolve(stateDir), "workspace"));
  });

  it("combines OPENCLAW_STATE_DIR and profile correctly", () => {
    const stateDir = path.join(path.sep, "srv", "openclaw-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_PROFILE", "work");

    expect(resolveDefaultAgentWorkspaceDir()).toBe(
      path.join(path.resolve(stateDir), "workspace-work"),
    );
  });
});
