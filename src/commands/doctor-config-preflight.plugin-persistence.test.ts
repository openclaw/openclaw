import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as migrationCheckpoint from "../infra/startup-migration-checkpoint.js";
import {
  getCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  runOutsidePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createConfigPreflightSnapshotReader } from "./config-preflight-snapshot.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const freshCache = <T>(run: () => T) => withPluginCache(createPluginCache(), run);
const readIndex = () =>
  freshCache(() => readPersistedInstalledPluginIndexSync({ env: process.env }));
const startup = () => runStartupConfigPreflight({ gateway: true, observe: false });
const metadataReadOptions = {
  purpose: "doctor",
  allowCurrentPluginMetadata: true,
  includePluginMetadata: true,
  skipPluginValidation: false,
  observe: false,
} as const;
const pluginIds = (plugins: { id: string }[]) =>
  plugins
    .filter((p) => p.id.startsWith("preflight-"))
    .map((p) => p.id)
    .toSorted();
const fixtureIds = ["preflight-alpha", "preflight-beta"];
const pluginRoot = (workspace: string, id: string) =>
  path.join(workspace, ".openclaw/extensions", id);
const metadata = (names: string[], version: string) => ({
  registrySource: "derived",
  plugins: expect.arrayContaining(
    names.map((name) => expect.objectContaining({ id: `preflight-${name}`, version })),
  ),
});
const expectNotPersisted = () => {
  expect(readIndex()).toBeNull();
  expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(false);
};
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const snapshotVersion = (snapshot: PluginMetadataSnapshot | undefined, name = "fixture") =>
  snapshot?.plugins.find((p) => p.id === `preflight-${name}`)?.version;
const discover = (config: OpenClawConfig, workspaceDir?: string) =>
  discoverConfigWidePluginManifestRegistry({ config, env: process.env, workspaceDir });

async function withPreflightPluginFixture(
  run: (
    writeVersion: (version: string) => Promise<void>,
    config: OpenClawConfig,
    workspaces: Record<string, string>,
  ) => Promise<void>,
  workspaceNames: string[] = [],
) {
  await withDoctorConfigPreflightHome(async (home) => {
    const bundledRoot = path.join(home, "bundled");
    await fs.mkdir(bundledRoot, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    const workspaces = Object.fromEntries(
      workspaceNames.map((name) => [name, path.join(home, name)]),
    );
    const plugins = workspaceNames.length
      ? workspaceNames.map((name) => ({
          id: `preflight-${name}`,
          root: pluginRoot(workspaces[name]!, `preflight-${name}`),
        }))
      : [{ id: "preflight-fixture", root: path.join(home, "fixture-plugin") }];
    for (const { root } of plugins) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "index.js"), 'throw new Error("metadata executed");');
    }
    const writeVersion = async (version: string) => {
      for (const { id, root } of plugins) {
        await writeJson(path.join(root, "package.json"), {
          name: id,
          version,
          openclaw: { extensions: ["./index.js"] },
        });
        await writeJson(path.join(root, "openclaw.plugin.json"), {
          id,
          version,
          configSchema: { type: "object", properties: { label: { type: "string" } } },
        });
      }
    };
    await writeVersion("1.0.0");
    const config: OpenClawConfig = {
      meta: { migrations: { webhookListeners: true } },
      plugins: { allow: plugins.map(({ id }) => id) },
    };
    if (workspaceNames.length) {
      config.agents = {
        ownership: "explicit",
        // Execution deliberately selects the aggregate's second workspace.
        defaults: { systemAgent: { agentId: workspaceNames[1] } },
        entries: Object.fromEntries(
          workspaceNames.map((name) => [name, { workspace: workspaces[name] }]),
        ),
      };
      config.plugins!.slots = { memory: "none" };
      config.plugins!.entries = Object.fromEntries(
        plugins.map(({ id }) => [id, { enabled: true }]),
      );
    } else {
      config.plugins!.load = { paths: plugins.map(({ root }) => root) };
    }
    await writeOpenClawConfig(home, config);
    openOpenClawStateDatabase({ env: process.env });
    await run(writeVersion, config, workspaces);
  });
}

const readPluginPreflight = async () => {
  await using snapshots = createConfigPreflightSnapshotReader();
  return snapshots.read(metadataReadOptions);
};

afterEach(() => closeOpenClawStateDatabaseForTest());

it("admits validated derived metadata while the startup writer lease is unavailable", async () => {
  await withPreflightPluginFixture(async () => {
    const lease = await migrationCheckpoint.acquireStartupMigrationLeaseWithWait({
      timeoutMs: 0,
    });
    // Fail immediately if startup tries to wait for the held writer; no wall-clock timeout.
    const acquire = vi
      .spyOn(migrationCheckpoint, "acquireStartupMigrationLeaseWithWait")
      .mockRejectedValue(new Error("fixture startup writer lease unavailable"));
    try {
      expect(await startup()).toMatchObject({
        snapshot: { valid: true },
        pluginMetadataSnapshot: metadata(["fixture"], "1.0.0"),
      });
      expect(readIndex()).toBeNull();
      expect(migrationCheckpoint.hasActiveStartupMigrationLease()).toBe(true);
    } finally {
      acquire.mockRestore();
      lease.release();
    }
  });
});

it("retains the original beta scope and full config-wide inventory without persisting it", async () => {
  const first = "beta";
  const names = [first, "alpha"];
  await withPreflightPluginFixture(async (writeVersion, _config, workspaces) => {
    await freshCache(async () => {
      const initial = await readPluginPreflight();
      const aggregate = initial.pluginMetadataSnapshot!;
      expect(aggregate.index.workspaceDir).toBe(workspaces[first]);
      expect(
        aggregate.index.plugins
          .filter((p) => p.pluginId.startsWith("preflight-"))
          .map((p) => p.pluginId)
          .toSorted(),
      ).toEqual(fixtureIds);
      const sourceConfig = initial.snapshot.sourceConfig;
      freshCache(() => {
        const discovered = discover(sourceConfig);
        expect(pluginIds(discovered.plugins)).toEqual(fixtureIds);
        for (const name of names) {
          const scoped = discover(sourceConfig, workspaces[name]);
          expect(pluginIds(scoped.plugins)).toEqual([`preflight-${name}`]);
        }
      });
      const metadataScope = createDoctorPluginMetadataSnapshotScope({
        getBaseSnapshot: () => aggregate,
      });
      const current = (config = sourceConfig, workspaceDir?: string) =>
        metadataScope.run({ config, workspaceDir }, () =>
          getCurrentPluginMetadataSnapshot({ config }),
        );
      // Unqualified Doctor work inherits its prepared view, not the system-agent workspace.
      expect(current()).toBe(aggregate);
      const otherWorkspace = workspaces[names[1]!];
      const other = current(sourceConfig, otherWorkspace);
      expect(other).not.toBe(aggregate);
      expect(other?.workspaceDir).toBe(otherWorkspace);
      const changedPolicy = {
        ...sourceConfig,
        plugins: { ...sourceConfig.plugins, deny: ["preflight-alpha"] },
      };
      const selected = current(changedPolicy);
      expect(selected).not.toBe(aggregate);
      expect(selected?.policyHash).toBe(
        resolveInstalledPluginIndexPolicyHash(changedPolicy, process.env),
      );
      expect(current()).toBe(aggregate);
      // The invoking generation remains old while the new admission owns current package facts.
      await writeVersion("2.0.0");
      expect(await runOutsidePluginCache(() => freshCache(startup))).toMatchObject({
        pluginMetadataSnapshot: metadata(names, "2.0.0"),
      });
      expectNotPersisted();

      expect(snapshotVersion((await readPluginPreflight()).pluginMetadataSnapshot, first)).toBe(
        "1.0.0",
      );
    });
  }, names);
});

it.each(["secondary-schema", "duplicate-owner"])(
  "keeps full config-wide validation before admission (%s)",
  async (failure) => {
    await withPreflightPluginFixture(
      async (_writeVersion, config, workspaces) => {
        if (failure === "secondary-schema") {
          config.plugins!.entries!["preflight-beta"]!.config = { label: 17 };
          const current = await readPluginPreflight();
          await writeJson(current.snapshot.path, config);
        } else {
          const manifestPath = path.join(
            pluginRoot(workspaces.beta!, "preflight-beta"),
            "openclaw.plugin.json",
          );
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
          await writeJson(manifestPath, { ...manifest, id: "preflight-alpha" });
          const discovered = freshCache(() => discover(config));
          expect(discovered.plugins.some((plugin) => plugin.id === "preflight-alpha")).toBe(false);
        }
        const result = await startup();
        expect(result.snapshot.valid).toBe(false);
        expect(result.snapshot.issues).toContainEqual(
          expect.objectContaining(
            failure === "secondary-schema"
              ? {
                  path: "plugins.entries.preflight-beta.config.label",
                  message: expect.stringContaining("must be string"),
                }
              : { message: expect.stringContaining("present in multiple agent workspaces") },
          ),
        );
        expectNotPersisted();
      },
      ["alpha", "beta"],
    );
  },
);

it("retains a refreshed Doctor snapshot's creating cache outside that cache", async () => {
  await withPreflightPluginFixture(async (writeVersion, config) => {
    const invoking = createPluginCache();
    await withPluginCache(invoking, async () => {
      await readPluginPreflight();
      await writeVersion("2.0.0");
      let producer: ReturnType<typeof getPluginCache> | undefined;
      await using snapshots = createConfigPreflightSnapshotReader();
      const refreshed = await snapshots.read({
        ...metadataReadOptions,
        allowCurrentPluginMetadata: false,
        measure: async (_name, operation) => {
          producer ??= getPluginCache();
          return await operation();
        },
      });
      expect(producer).toBeDefined();
      expect(producer).not.toBe(invoking);
      await writeVersion("3.0.0");
      const snapshot = refreshed.pluginMetadataSnapshot!;
      freshCache(() => {
        expect.soft(getPluginMetadataSnapshotCache(snapshot)).toBe(producer);
        withPluginMetadataSnapshotScope(
          snapshot,
          () => {
            expect.soft(getPluginCache()).toBe(producer);
            expect(
              snapshotVersion(
                resolvePluginMetadataSnapshot({ config, env: process.env, allowCurrent: false }),
              ),
            ).toBe("2.0.0");
          },
          { config, env: process.env },
        );
      });
      expect(getPluginCache()).toBe(invoking);
      expect(snapshotVersion((await readPluginPreflight()).pluginMetadataSnapshot!)).toBe("1.0.0");
    });
  });
});
