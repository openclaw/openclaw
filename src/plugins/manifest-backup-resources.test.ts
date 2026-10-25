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
    inventory: (config: OpenClawConfig, workspaceDirs?: string[]) =>
      resolveActivatedPluginBackupInventory({ config, env, stateDir, workspaceDirs }),
  };
}

describe("plugin manifest backup resources", () => {
  it.each([
    ["an absolute POSIX path", "/outside"],
    ["a Windows drive-relative path", "C:outside"],
    ["a backslash separator", "owner\\cache"],
    ["a NUL byte", "owner/\0cache"],
    ["an empty path", ""],
    ["an empty segment", "owner//cache"],
    ["a current-directory segment", "owner/./cache"],
    ["a parent-directory segment", "owner/../outside"],
  ])("rejects %s", (_label, relativePath) => {
    const fixture = createPluginFixture([resource({ relativePath })]);

    expect(loadPluginManifest(fixture.pluginRoot)).toMatchObject({
      ok: false,
      error: expect.stringContaining("strict relative POSIX path"),
    });
  });

  it.each([
    ["non-array declarations", {}],
    ["unknown disposition", [resource({ disposition: "exclude" })]],
    ["unknown scope", [resource({ scope: "workspace" })]],
    ["owner-controlled extra keys", [resource({ pluginId: "spoofed" })]],
    ["missing keys", [{ disposition: "include", relativePath: "owner" }]],
    ["unsupported database family", [resource({ databaseFamily: "unknown" })]],
    ["regenerable database", [resource({ disposition: "regenerable", databaseFamily: "state" })]],
    ["agent-scoped database", [resource({ scope: "agent", databaseFamily: "state" })]],
  ])("rejects %s", (_label, backupResources) => {
    const fixture = createPluginFixture(backupResources);

    expect(loadPluginManifest(fixture.pluginRoot)).toMatchObject({
      ok: false,
      error: expect.stringContaining("backupResources"),
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
    const config: OpenClawConfig = {
      plugins: {
        allow: [enabled.id, disabled.id],
        load: { paths: [enabled.pluginRoot, disabled.pluginRoot] },
        entries: {
          [enabled.id]: { enabled: true },
          [disabled.id]: { enabled: false },
        },
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
      const config: OpenClawConfig = {
        plugins: {
          ...(workspace ? { allow: [fixture.id] } : { load: { paths: [fixture.pluginRoot] } }),
          entries: { [fixture.id]: { enabled: activated } },
        },
      };
      const resolveInventory = () =>
        fixture.inventory(config, workspace ? [fixture.workspaceDir] : undefined);

      if (activated) {
        expect(resolveInventory).toThrow("invalid plugin manifest backupResources");
      } else {
        expect(resolveInventory()).toEqual({ pluginRoots: [fixture.pluginRoot], resources: [] });
      }
    },
  );

  it.each([false, true])(
    "retains only database resources when plugins are disabled (database=%s)",
    (database) => {
      const declaration = resource(database ? { databaseFamily: "state" } : {});
      const fixture = createPluginFixture([declaration]);
      expect(
        fixture.inventory({
          plugins: { enabled: false, load: { paths: [fixture.pluginRoot] } },
        }),
      ).toEqual({
        pluginRoots: [],
        resources: database ? [{ pluginId: fixture.id, ...declaration }] : [],
      });
    },
  );
});
