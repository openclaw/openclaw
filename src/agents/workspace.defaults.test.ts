import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeDefaultAgentWorkspacePath,
  resolveDefaultAgentWorkspaceDir,
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

  it("canonicalizes the resolved default workspace back to a portable path", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);

    expect(
      canonicalizeDefaultAgentWorkspacePath(
        path.join(path.resolve(home), ".openclaw", "workspace"),
      ),
    ).toBe("~/.openclaw/workspace");
  });

  it("preserves explicit custom absolute workspaces", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);

    expect(canonicalizeDefaultAgentWorkspacePath("/tmp/custom-workspace")).toBe(
      "/tmp/custom-workspace",
    );
  });

  it("canonicalizes profile-specific default workspaces", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    vi.stubEnv("OPENCLAW_PROFILE", "dev");

    expect(
      canonicalizeDefaultAgentWorkspacePath(
        path.join(path.resolve(home), ".openclaw", "workspace-dev"),
      ),
    ).toBe("~/.openclaw/workspace-dev");
  });
});
