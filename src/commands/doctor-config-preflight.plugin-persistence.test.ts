import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { readConfigPreflightSnapshot } from "./config-preflight-snapshot.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

async function withPreflightPluginFixture(
  run: (
    writeVersion: (version: string) => Promise<void>,
    config: OpenClawConfig,
    workspaces: Record<string, string>,
  ) => Promise<void>,
  workspaceNames: string[] = [],
) {
  await withDoctorConfigPreflightHome(async (home) => {
    // Scope real discovery to the synthetic plugins owned by this fixture.
    const bundledRoot = path.join(home, "bundled");
    await fs.mkdir(bundledRoot, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    const workspaces = Object.fromEntries(
      workspaceNames.map((name) => [name, path.join(home, name)]),
    );
    const plugins = workspaceNames.length
      ? workspaceNames.map((name) => ({
          id: `preflight-${name}`,
          root: path.join(workspaces[name]!, ".openclaw", "extensions", `preflight-${name}`),
        }))
      : [{ id: "preflight-fixture", root: path.join(home, "fixture-plugin") }];
    for (const { root } of plugins) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "index.js"), 'throw new Error("metadata executed");');
    }
    const writeVersion = async (version: string) => {
      for (const { id, root } of plugins) {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({
            name: id,
            version,
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        await fs.writeFile(
          path.join(root, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            version,
            configSchema: { type: "object", properties: { label: { type: "string" } } },
          }),
        );
      }
    };
    await writeVersion("1.0.0");
    const config: OpenClawConfig = {
      meta: { migrations: { webhookListeners: true } },
      ...(workspaceNames.length
        ? {
            agents: {
              ownership: "explicit",
              // The selected execution owner deliberately differs from the aggregate's first scope.
              defaults: { systemAgent: { agentId: workspaceNames[1] } },
              entries: Object.fromEntries(
                workspaceNames.map((name) => [name, { workspace: workspaces[name] }]),
              ),
            },
          }
        : {}),
      plugins: {
        allow: plugins.map(({ id }) => id),
        ...(workspaceNames.length
          ? {
              slots: { memory: "none" },
              entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])),
            }
          : { load: { paths: plugins.map(({ root }) => root) } }),
      },
    };
    await writeOpenClawConfig(home, config);
    // Startup only reads these canonical fixture databases.
    openOpenClawStateDatabase({ env: process.env });
    await run(writeVersion, config, workspaces);
  });
}

const readPluginPreflight = () =>
  readConfigPreflightSnapshot({
    purpose: "doctor",
    allowCurrentPluginMetadata: true,
    includePluginMetadata: true,
    skipPluginValidation: false,
    observe: false,
  });

describe("startup plugin metadata admission", () => {
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
        const result = await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(result.snapshot.valid).toBe(true);
        expect(result.pluginMetadataSnapshot?.registrySource).toBe("derived");
        expect(result.pluginMetadataSnapshot?.plugins).toContainEqual(
          expect.objectContaining({ id: "preflight-fixture", version: "1.0.0" }),
        );
        expect(
          withPluginCache(createPluginCache(), () =>
            readPersistedInstalledPluginIndexSync({ env: process.env }),
          ),
        ).toBeNull();
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
      await withPluginCache(createPluginCache(), async () => {
        const initial = await readPluginPreflight();
        const aggregate = initial.pluginMetadataSnapshot!;
        expect(aggregate.index.workspaceDir).toBe(workspaces[first]);
        expect(
          aggregate.index.plugins
            .filter((p) => p.pluginId.startsWith("preflight-"))
            .map((p) => p.pluginId)
            .toSorted(),
        ).toEqual(["preflight-alpha", "preflight-beta"]);
        const sourceConfig = initial.snapshot.sourceConfig;
        withPluginCache(createPluginCache(), () => {
          const discovered = discoverConfigWidePluginManifestRegistry({
            config: sourceConfig,
            env: process.env,
          });
          expect(
            discovered.plugins
              .filter((plugin) => plugin.id.startsWith("preflight-"))
              .map((plugin) => plugin.id)
              .toSorted(),
          ).toEqual(["preflight-alpha", "preflight-beta"]);
          for (const name of names) {
            const scoped = discoverConfigWidePluginManifestRegistry({
              config: sourceConfig,
              env: process.env,
              workspaceDir: workspaces[name],
            });
            expect(
              scoped.plugins
                .filter((plugin) => plugin.id.startsWith("preflight-"))
                .map((plugin) => plugin.id),
            ).toEqual([`preflight-${name}`]);
          }
        });
        const metadataScope = createDoctorPluginMetadataSnapshotScope({
          getBaseSnapshot: () => aggregate,
        });
        // Unqualified Doctor work inherits its prepared view, not the system-agent workspace.
        metadataScope.run({ config: sourceConfig }, () => {
          expect(getCurrentPluginMetadataSnapshot({ config: sourceConfig }) === aggregate).toBe(
            true,
          );
        });
        const otherWorkspace = workspaces[names[1]!];
        metadataScope.run({ config: sourceConfig, workspaceDir: otherWorkspace }, () => {
          const selected = getCurrentPluginMetadataSnapshot({ config: sourceConfig });
          expect(selected === aggregate).toBe(false);
          expect(selected?.workspaceDir).toBe(otherWorkspace);
        });
        const changedPolicy = {
          ...sourceConfig,
          plugins: { ...sourceConfig.plugins, deny: ["preflight-alpha"] },
        };
        metadataScope.run({ config: changedPolicy }, () => {
          const selected = getCurrentPluginMetadataSnapshot({ config: changedPolicy });
          expect(selected === aggregate).toBe(false);
          expect(selected?.policyHash).toBe(
            resolveInstalledPluginIndexPolicyHash(changedPolicy, process.env),
          );
        });
        metadataScope.run({ config: sourceConfig }, () => {
          expect(getCurrentPluginMetadataSnapshot({ config: sourceConfig }) === aggregate).toBe(
            true,
          );
        });
        const preflight = () =>
          runOutsidePluginCache(() =>
            withPluginCache(createPluginCache(), () =>
              runStartupConfigPreflight({
                gateway: true,
                observe: false,
              }),
            ),
          );
        // The invoking generation remains old while the new admission owns current package facts.
        await writeVersion("2.0.0");
        const result = await preflight().catch((error: unknown) => error);
        expect.soft(result).not.toBeInstanceOf(Error);
        expect.soft(result).toMatchObject({
          pluginMetadataSnapshot: {
            registrySource: "derived",
            plugins: expect.arrayContaining(
              names.map((name) =>
                expect.objectContaining({
                  id: `preflight-${name}`,
                  version: "2.0.0",
                }),
              ),
            ),
          },
        });
        const durable = withPluginCache(createPluginCache(), () =>
          readPersistedInstalledPluginIndexSync({ env: process.env }),
        );
        expect(durable).toBeNull();
        expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
          false,
        );

        expect(
          (await readPluginPreflight()).pluginMetadataSnapshot?.plugins.find(
            (p) => p.id === `preflight-${first}`,
          )?.version,
        ).toBe("1.0.0");
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
            await fs.writeFile(current.snapshot.path, JSON.stringify(config));
          } else {
            const manifestPath = path.join(
              workspaces.beta!,
              ".openclaw",
              "extensions",
              "preflight-beta",
              "openclaw.plugin.json",
            );
            const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
            await fs.writeFile(
              manifestPath,
              JSON.stringify({ ...manifest, id: "preflight-alpha" }),
            );
            const discovered = withPluginCache(createPluginCache(), () =>
              discoverConfigWidePluginManifestRegistry({ config, env: process.env }),
            );
            expect(discovered.plugins.some((plugin) => plugin.id === "preflight-alpha")).toBe(
              false,
            );
            expect(discovered.diagnostics).toContainEqual(
              expect.objectContaining({
                level: "error",
                pluginId: "preflight-alpha",
                message: expect.stringContaining("present in multiple agent workspaces"),
              }),
            );
          }
          const result = await runStartupConfigPreflight({
            gateway: true,
            observe: false,
          });
          expect(result.snapshot.valid).toBe(false);
          expect(result.snapshot.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining(
                failure === "secondary-schema"
                  ? {
                      path: "plugins.entries.preflight-beta.config.label",
                      message: expect.stringContaining("must be string"),
                    }
                  : { message: expect.stringContaining("present in multiple agent workspaces") },
              ),
            ]),
          );
          expect(
            withPluginCache(createPluginCache(), () =>
              readPersistedInstalledPluginIndexSync({ env: process.env }),
            ),
          ).toBeNull();
          expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
            false,
          );
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
        const refreshed = await readConfigPreflightSnapshot({
          purpose: "doctor",
          allowCurrentPluginMetadata: false,
          includePluginMetadata: true,
          skipPluginValidation: false,
          observe: false,
          measure: async (_name, operation) => {
            producer ??= getPluginCache();
            return await operation();
          },
        });
        expect(producer).toBeDefined();
        expect(producer).not.toBe(invoking);
        await writeVersion("3.0.0");
        const snapshot = refreshed.pluginMetadataSnapshot!;
        const version = (metadata: typeof snapshot) =>
          metadata.plugins.find((p) => p.id === "preflight-fixture")?.version;
        withPluginCache(createPluginCache(), () => {
          expect.soft(getPluginMetadataSnapshotCache(snapshot) === producer).toBe(true);
          withPluginMetadataSnapshotScope(
            snapshot,
            () => {
              expect.soft(getPluginCache() === producer).toBe(true);
              expect(
                version(
                  resolvePluginMetadataSnapshot({ config, env: process.env, allowCurrent: false }),
                ),
              ).toBe("2.0.0");
            },
            { config, env: process.env },
          );
        });
        expect(getPluginCache()).toBe(invoking);
        expect(version((await readPluginPreflight()).pluginMetadataSnapshot!)).toBe("1.0.0");
      });
    });
  });
});
