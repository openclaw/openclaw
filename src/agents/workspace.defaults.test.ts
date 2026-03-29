import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  portableDefaultAgentWorkspacePath,
  resolveDefaultAgentWorkspaceDir,
  workspaceResolvedDirToConfigValue,
} from "./workspace.js";

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

  it("portableDefaultAgentWorkspacePath reflects OPENCLAW_PROFILE", () => {
    vi.stubEnv("OPENCLAW_PROFILE", "dev");
    expect(portableDefaultAgentWorkspacePath()).toBe("~/.openclaw/workspace-dev");
    vi.stubEnv("OPENCLAW_PROFILE", "default");
    expect(portableDefaultAgentWorkspacePath()).toBe("~/.openclaw/workspace");
  });

  it("workspaceResolvedDirToConfigValue uses portable path only for the default workspace dir", () => {
    const def = resolveDefaultAgentWorkspaceDir();
    expect(workspaceResolvedDirToConfigValue(def)).toBe("~/.openclaw/workspace");
    expect(workspaceResolvedDirToConfigValue(path.join(def, "extra"))).toBe(
      path.join(def, "extra"),
    );
  });
});
