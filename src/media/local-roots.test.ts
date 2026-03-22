import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentScopedMediaLocalRoots, getDefaultMediaLocalRoots } from "./local-roots.js";

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

describe("local media roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps temp, media cache, and workspace roots by default", () => {
    const stateDir = path.join("/tmp", "openclaw-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getDefaultMediaLocalRoots();
    const normalizedRoots = roots.map(normalizeHostPath);

    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "media")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "sandboxes")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(path.join(stateDir, "agents")));
    expect(roots.length).toBeGreaterThanOrEqual(3);
  });

  it("adds the active agent workspace without re-opening broad agent state roots", () => {
    const stateDir = path.join("/tmp", "openclaw-agent-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getAgentScopedMediaLocalRoots({}, "ops");
    const normalizedRoots = roots.map(normalizeHostPath);

    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-ops")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "sandboxes")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(path.join(stateDir, "agents")));
  });
});
