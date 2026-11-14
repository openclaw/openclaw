import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveActivatedPluginBackupInventory } from "./manifest-backup-resources.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeArtifacts as writeFiles } from "./public-surface.test-support.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    cleanup();
  }),
);
const resource = (overrides: Record<string, unknown> = {}) => ({
  disposition: "include",
  scope: "state",
  relativePath: "owner",
  ...overrides,
});

function createPluginFixture(
  backupResources: unknown,
  params: {
    id?: string;
    root?: string;
    workspace?: boolean;
  } = {},
) {
  const root = params.root ?? roots.make("backup-owner-");
  const id = params.id ?? "backup-owner";
  const workspaceDir = path.join(root, "workspace");
  const pluginRoot = params.workspace
    ? path.join(workspaceDir, ".openclaw", "extensions", id)
    : path.join(root, id);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  writeFiles(pluginRoot, {
    "openclaw.plugin.json": {
      id,
      configSchema: { type: "object", additionalProperties: false },
      backupResources,
    },
    "index.ts": 'throw new Error("plugin runtime activated")',
  });
  const env = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "no-bundled-plugins"),
  };
  return {
    id,
    pluginRoot,
    workspaceDir,
    inventory: (plugins: NonNullable<OpenClawConfig["plugins"]>, workspaceDirs?: string[]) =>
      resolveActivatedPluginBackupInventory({
        config: {
          plugins: {
            ...(params.workspace ? { allow: [id] } : { load: { paths: [pluginRoot] } }),
            ...plugins,
          },
        },
        env,
        stateDir,
        workspaceDirs: workspaceDirs ?? (params.workspace ? [workspaceDir] : undefined),
      }),
  };
}

describe("plugin manifest backup resources", () => {
  const invalidPaths = (
    [
      ["an absolute POSIX path", "/outside"],
      ["a Windows drive-relative path", "C:outside"],
      ["a backslash separator", "owner\\cache"],
      ["a NUL byte", "owner/\0cache"],
      ["an empty path", ""],
      ["an empty segment", "owner//cache"],
      ["a current-directory segment", "owner/./cache"],
      ["a parent-directory segment", "owner/../outside"],
    ] as const
  ).map(([label, relativePath]) => [label, [resource({ relativePath })]] as const);
  it.each([
    ...invalidPaths,
    ["non-array declarations", {}],
    ["unknown disposition", [resource({ disposition: "exclude" })]],
    ["unknown scope", [resource({ scope: "workspace" })]],
    ["owner-controlled extra keys", [resource({ pluginId: "spoofed" })]],
    ["missing keys", [{ disposition: "include", relativePath: "owner" }]],
    ["unsupported database family", [resource({ databaseFamily: "unknown" })]],
    ["regenerable database", [resource({ disposition: "regenerable", databaseFamily: "state" })]],
    ["agent-scoped database", [resource({ scope: "agent", databaseFamily: "state" })]],
  ] as const)("rejects %s", (_label, backupResources) => {
    const fixture = createPluginFixture(backupResources);
    expect(loadPluginManifest(fixture.pluginRoot)).toMatchObject({
      ok: false,
      diagnosticCode: "backup-resource-declaration-invalid",
    });
  });

  it("resolves only activated loadable owners without activating plugin runtime", () => {
    const included = resource({ relativePath: "plugins/backup-owner/durable" });
    const regenerable = resource({
      disposition: "regenerable",
      scope: "agent",
      relativePath: "backup-owner/cache",
    });
    const enabled = createPluginFixture([included, regenerable, included]);
    const disabled = createPluginFixture(
      [{ ...regenerable, relativePath: "disabled-owner/cache" }],
      {
        root: path.dirname(enabled.pluginRoot),
        id: "disabled-owner",
      },
    );
    const config = {
      allow: [enabled.id, disabled.id],
      load: { paths: [enabled.pluginRoot, disabled.pluginRoot] },
      entries: {
        [enabled.id]: { enabled: true },
        [disabled.id]: { enabled: false },
      },
    };

    expect(enabled.inventory(config, [enabled.workspaceDir])).toEqual({
      pluginRoots: [],
      resources: [
        { pluginId: enabled.id, ...regenerable },
        { pluginId: enabled.id, ...included },
      ],
    });
  });

  it.each([
    { workspace: false, activated: true },
    { workspace: true, activated: false },
    { workspace: true, activated: true },
  ])(
    "rejects invalid declarations only for active owners (workspace=$workspace, activated=$activated)",
    ({ workspace, activated }) => {
      const fixture = createPluginFixture([resource({ relativePath: "../outside" })], {
        workspace,
      });
      const resolveInventory = () =>
        fixture.inventory({ entries: { [fixture.id]: { enabled: activated } } });

      if (activated) {
        expect(resolveInventory).toThrow("invalid plugin manifest backupResources");
      } else {
        expect(resolveInventory()).toEqual({ pluginRoots: [fixture.pluginRoot], resources: [] });
      }
    },
  );

  it("retains only database resources when plugins are disabled", () => {
    const database = resource({ databaseFamily: "state" });
    const fixture = createPluginFixture([database, resource({ relativePath: "cache" })]);
    expect(fixture.inventory({ enabled: false })).toEqual({
      pluginRoots: [],
      resources: [{ pluginId: fixture.id, ...database }],
    });
  });
});
