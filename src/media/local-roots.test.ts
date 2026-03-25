import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
  getDefaultMediaLocalRoots,
} from "./local-roots.js";

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

  it("adds concrete parent roots for local media sources without widening to filesystem root", () => {
    const roots = appendLocalMediaParentRoots(
      ["/tmp/base"],
      [
        "/Users/peter/Pictures/photo.png",
        "file:///Users/peter/Movies/clip.mp4",
        "https://example.com/remote.png",
        "/top-level-file.png",
      ],
    );

    expect(roots.map(normalizeHostPath)).toEqual(
      expect.arrayContaining([
        normalizeHostPath("/tmp/base"),
        normalizeHostPath("/Users/peter/Pictures"),
        normalizeHostPath("/Users/peter/Movies"),
      ]),
    );
    expect(roots.map(normalizeHostPath)).not.toContain(normalizeHostPath("/"));
  });

  it("widens agent media roots for concrete local sources only when workspaceOnly is disabled", () => {
    const stateDir = path.join("/tmp", "openclaw-flexible-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const flexibleRoots = getAgentScopedMediaLocalRootsForSources({
      cfg: {},
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
    expect(flexibleRoots.map(normalizeHostPath)).toContain(
      normalizeHostPath("/Users/peter/Pictures"),
    );

    const strictRoots = getAgentScopedMediaLocalRootsForSources({
      cfg: { tools: { fs: { workspaceOnly: true } } },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
    expect(strictRoots.map(normalizeHostPath)).not.toContain(
      normalizeHostPath("/Users/peter/Pictures"),
    );
  });
});
