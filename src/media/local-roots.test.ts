// Local media root tests cover allowed root normalization and matching.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots as getAgentScopedMediaLocalRootsBase,
  getAgentScopedMediaLocalRootsForSources as getAgentScopedMediaLocalRootsForSourcesBase,
  getDefaultMediaLocalRoots,
  getSessionSafeDefaultMediaLocalRoots,
} from "./local-roots.js";

const testTempRoot = realpathSync(os.tmpdir());

function loadedConfig(config: OpenClawConfig): OpenClawConfig {
  return migratePersistedImplicitMainRoster(config).config as OpenClawConfig;
}

function getAgentScopedMediaLocalRoots(
  config: OpenClawConfig,
  agentId?: string,
  sessionWorkspaceDir?: string,
) {
  return getAgentScopedMediaLocalRootsBase(loadedConfig(config), agentId, sessionWorkspaceDir);
}

function getAgentScopedMediaLocalRootsForSources(
  params: Parameters<typeof getAgentScopedMediaLocalRootsForSourcesBase>[0],
) {
  return getAgentScopedMediaLocalRootsForSourcesBase({
    ...params,
    cfg: loadedConfig(params.cfg),
  });
}

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

describe("local media roots", () => {
  it.each([
    {
      name: "keeps temp, media cache, canvas, and workspace roots by default",
      stateDir: path.join(testTempRoot, "openclaw-media-roots-state"),
      getRoots: () => getDefaultMediaLocalRoots(),
      expectedContained: ["media", "canvas", "workspace", "sandboxes"],
      expectedExcluded: ["agents"],
      minLength: 4,
    },
    {
      name: "adds the active agent workspace without re-opening broad agent or sandbox roots",
      stateDir: path.join(testTempRoot, "openclaw-agent-media-roots-state"),
      getRoots: () => getAgentScopedMediaLocalRoots({}, "ops"),
      expectedContained: ["workspace-ops"],
      expectedExcluded: ["agents", "sandboxes"],
    },
    {
      name: "replaces broad workspace and sandbox roots with the exact session workspace",
      stateDir: path.join(testTempRoot, "openclaw-session-media-roots-state"),
      getRoots: () =>
        getAgentScopedMediaLocalRoots(
          {},
          "ops",
          path.join(testTempRoot, "openclaw-session-media-roots-state", "sandboxes", "session-a"),
        ),
      expectedContained: ["sandboxes/session-a"],
      expectedExcluded: ["agents", "workspace", "sandboxes"],
    },
    {
      name: "does not accept the shared sandbox parent as an exact session workspace",
      stateDir: path.join(testTempRoot, "openclaw-shared-sandbox-parent-state"),
      getRoots: () =>
        getAgentScopedMediaLocalRoots(
          {},
          "ops",
          path.join(testTempRoot, "openclaw-shared-sandbox-parent-state", "sandboxes"),
        ),
      expectedContained: [],
      expectedExcluded: ["agents", "workspace", "sandboxes"],
    },
  ] as const)("$name", ({ stateDir, getRoots, expectedContained, expectedExcluded, minLength }) => {
    const roots = withEnv({ OPENCLAW_STATE_DIR: stateDir }, getRoots).map(normalizeHostPath);
    for (const suffix of expectedContained) {
      expect(roots).toContain(normalizeHostPath(path.join(stateDir, suffix)));
    }
    for (const suffix of expectedExcluded) {
      expect(roots).not.toContain(normalizeHostPath(path.join(stateDir, suffix)));
    }
    if (minLength !== undefined) {
      expect(roots.length).toBeGreaterThanOrEqual(minLength);
    }
  });

  it("does not promote sibling sandbox directories via source-parent expansion", () => {
    const stateDir = path.join(testTempRoot, "openclaw-sibling-sandbox-expansion-state");
    const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "session-a");
    const siblingFile = path.join(stateDir, "sandboxes", "session-b", "secret.txt");

    const roots = withStateDir(stateDir, () =>
      getAgentScopedMediaLocalRootsForSources({
        cfg: {},
        agentId: "ops",
        mediaSources: [siblingFile],
        sessionWorkspaceDir,
      }),
    );

    expectNormalizedRootsContain(roots, [sessionWorkspaceDir]);
    expectNormalizedRootsExclude(roots, [
      path.join(stateDir, "sandboxes"),
      path.join(stateDir, "sandboxes", "session-b"),
    ]);
  });

  it("does not re-add the shared workspace via source-parent expansion for sandboxed sessions", () => {
    const stateDir = path.join(testTempRoot, "openclaw-shared-workspace-expansion-state");
    const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "session-a");
    const sharedWorkspaceFile = path.join(stateDir, "workspace", "notes.png");

    const roots = withStateDir(stateDir, () =>
      getAgentScopedMediaLocalRootsForSources({
        cfg: {},
        agentId: "ops",
        mediaSources: [sharedWorkspaceFile],
        sessionWorkspaceDir,
      }),
    );

    expectNormalizedRootsExclude(roots, [path.join(stateDir, "workspace")]);
  });

  it("keeps parent expansion for locations outside shared isolation parents", () => {
    const stateDir = path.join(testTempRoot, "openclaw-parent-expansion-state");
    const externalDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Downloads" : "/Users/peter/Downloads";

    const roots = withStateDir(stateDir, () =>
      getAgentScopedMediaLocalRootsForSources({
        cfg: {},
        agentId: "ops",
        mediaSources: [path.join(externalDir, "clip.mp4")],
      }),
    );

    expectNormalizedRootsContain(roots, [externalDir]);
    expectNormalizedRootsExclude(roots, [path.join(stateDir, "sandboxes")]);
  });

  it("keeps own sandbox parents readable via source-parent expansion", () => {
    const stateDir = path.join(testTempRoot, "openclaw-own-sandbox-expansion-state");
    const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "session-a");
    const ownFile = path.join(sessionWorkspaceDir, "media", "clip.mp4");

    const roots = withStateDir(stateDir, () =>
      getAgentScopedMediaLocalRootsForSources({
        cfg: {},
        agentId: "ops",
        mediaSources: [ownFile],
        sessionWorkspaceDir,
      }),
    );

    expectNormalizedRootsContain(roots, [path.join(sessionWorkspaceDir, "media")]);
  });

  it("excludes shared sandbox parents from session-safe default attachment roots", () => {
    const stateDir = path.join(testTempRoot, "openclaw-session-safe-defaults-state");

    const roots = withStateDir(stateDir, () => getSessionSafeDefaultMediaLocalRoots());

    expectNormalizedRootsExclude(roots, [
      path.join(stateDir, "sandboxes"),
      path.join(stateDir, "sandboxes", "session-a"),
    ]);
    expectNormalizedRootsContain(roots, [path.join(stateDir, "workspace")]);
  });

  it("drops the shared workspace from session-safe attachment roots for sandboxed sessions", () => {
    const stateDir = path.join(testTempRoot, "openclaw-session-safe-sandbox-state");
    const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "session-a");

    const roots = withStateDir(stateDir, () =>
      getSessionSafeDefaultMediaLocalRoots(sessionWorkspaceDir),
    );

    // The session workspace itself is merged back by the caller
    // (resolveMediaAttachmentLocalRoots adds params.workspaceDir explicitly).
    expectNormalizedRootsExclude(roots, [
      path.join(stateDir, "workspace"),
      path.join(stateDir, "sandboxes"),
      path.join(stateDir, "sandboxes", "session-b"),
    ]);
  });

  it("keeps the shared workspace in session-safe attachment roots when the session workspace lives inside it", () => {
    const stateDir = path.join(testTempRoot, "openclaw-session-safe-host-workspace-state");

    const roots = withStateDir(stateDir, () =>
      getSessionSafeDefaultMediaLocalRoots(path.join(stateDir, "workspace")),
    );

    expectNormalizedRootsContain(roots, [path.join(stateDir, "workspace")]);
    expectNormalizedRootsExclude(roots, [path.join(stateDir, "sandboxes")]);
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

    expect(roots.map(normalizeHostPath)).toStrictEqual([
      normalizeHostPath("/tmp/base"),
      normalizeHostPath(picturesDir),
      normalizeHostPath(moviesDir),
    ]);
    expect(roots.map(normalizeHostPath)).not.toContain(normalizeHostPath("/"));
  });

  it("does not widen local roots for pass-through media schemes", () => {
    const roots = appendLocalMediaParentRoots(
      ["/tmp/base"],
      ["mxc://matrix.org/abc123def456", "buffer://message-send/attachment"],
    );

    expect(roots.map(normalizeHostPath)).toEqual([normalizeHostPath("/tmp/base")]);
  });

  it.each([
    {
      name: "widens agent media roots for concrete local sources when workspaceOnly is disabled",
      stateDir: path.join(testTempRoot, "openclaw-flexible-media-roots-state"),
      cfg: {},
      shouldContainPictures: true,
    },
    {
      name: "does not widen agent media roots when workspaceOnly is enabled",
      stateDir: path.join(testTempRoot, "openclaw-flexible-media-roots-state"),
      cfg: { tools: { fs: { workspaceOnly: true } } },
      shouldContainPictures: false,
    },
    {
      name: "does not widen media roots for messaging-profile agents without filesystem tools",
      stateDir: path.join(testTempRoot, "openclaw-messaging-media-roots-state"),
      cfg: { tools: { profile: "messaging" } },
      shouldContainPictures: false,
    },
    {
      name: "does not widen media roots when messaging-profile agents only configure filesystem guards",
      stateDir: path.join(testTempRoot, "openclaw-messaging-fs-media-roots-state"),
      cfg: {
        tools: {
          profile: "messaging",
          fs: { workspaceOnly: false },
        },
      },
      shouldContainPictures: false,
    },
    {
      name: "widens media roots when messaging-profile agents explicitly allow reads",
      stateDir: path.join(testTempRoot, "openclaw-messaging-read-media-roots-state"),
      cfg: {
        tools: {
          profile: "messaging",
          alsoAllow: ["read"] as string[],
          fs: { workspaceOnly: false },
        },
      },
      shouldContainPictures: true,
    },
  ] as const)("$name", ({ stateDir, cfg, shouldContainPictures }) => {
    const roots = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      getAgentScopedMediaLocalRootsForSources({
        cfg,
        agentId: "ops",
        mediaSources: ["/Users/peter/Pictures/photo.png"],
      }),
    );
    expect(roots.map(normalizeHostPath).includes(normalizeHostPath("/Users/peter/Pictures"))).toBe(
      shouldContainPictures,
    );
  });
});
