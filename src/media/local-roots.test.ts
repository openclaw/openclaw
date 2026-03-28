import path from "node:path";
import { pathToFileURL } from "node:url";
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
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";
    const moviesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Movies" : "/Users/peter/Movies";

    const roots = appendLocalMediaParentRoots(
      ["/tmp/base"],
      [
        path.join(picturesDir, "photo.png"),
        pathToFileURL(path.join(moviesDir, "clip.mp4")).href,
        "https://example.com/remote.png",
        "/top-level-file.png",
      ],
    );

    expect(roots.map(normalizeHostPath)).toEqual(
      expect.arrayContaining([
        normalizeHostPath("/tmp/base"),
        normalizeHostPath(picturesDir),
        normalizeHostPath(moviesDir),
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

  it("does not widen media roots for messaging-profile agents without filesystem tools", () => {
    const stateDir = path.join("/tmp", "openclaw-messaging-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getAgentScopedMediaLocalRootsForSources({
      cfg: { tools: { profile: "messaging" } },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(roots.map(normalizeHostPath)).not.toContain(normalizeHostPath("/Users/peter/Pictures"));
  });

  it("widens media roots again when messaging-profile agents explicitly enable filesystem tools", () => {
    const stateDir = path.join("/tmp", "openclaw-messaging-fs-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getAgentScopedMediaLocalRootsForSources({
      cfg: {
        tools: {
          profile: "messaging",
          fs: { workspaceOnly: false },
        },
      },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(roots.map(normalizeHostPath)).toContain(normalizeHostPath("/Users/peter/Pictures"));
  });
});
