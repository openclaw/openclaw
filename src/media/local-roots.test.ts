import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentScopedMediaLocalRoots, getDefaultMediaLocalRoots } from "./local-roots.js";

describe("local media roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps temp, media cache, and workspace roots by default", () => {
    const stateDir = path.join("/tmp", "openclaw-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getDefaultMediaLocalRoots();

    expect(roots).toContain(path.join(stateDir, "media"));
    expect(roots).toContain(path.join(stateDir, "workspace"));
    expect(roots).toContain(path.join(stateDir, "sandboxes"));
    expect(roots).not.toContain(path.join(stateDir, "agents"));
    expect(roots.length).toBeGreaterThanOrEqual(3);
  });

  it("adds the active agent workspace without re-opening broad agent state roots", () => {
    const stateDir = path.join("/tmp", "openclaw-agent-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getAgentScopedMediaLocalRoots({}, "ops");

    expect(roots).toContain(path.join(stateDir, "workspace-ops"));
    expect(roots).toContain(path.join(stateDir, "sandboxes"));
    expect(roots).not.toContain(path.join(stateDir, "agents"));
  });
});
