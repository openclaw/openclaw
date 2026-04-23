import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMediaToolLocalRoots } from "./media-tool-shared.js";

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

describe("resolveMediaToolLocalRoots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not widen default local roots from media sources", () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";
    const moviesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Movies" : "/Users/peter/Movies";

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = resolveMediaToolLocalRoots(path.join(stateDir, "workspace-agent"), undefined, [
      path.join(picturesDir, "photo.png"),
      pathToFileURL(path.join(moviesDir, "clip.mp4")).href,
      "/top-level-file.png",
    ]);

    const normalizedRoots = roots.map((root) =>
      normalizeHostPath(typeof root === "string" ? root : root.path),
    );
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath(moviesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
  });
});
