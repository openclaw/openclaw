import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import * as migrationCheckpoint from "../infra/startup-migration-checkpoint.js";
import { readBundledDiscoveryModeMemoized } from "../plugins/bundled-discovery-state.js";
import {
  getCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexWithLeaseSync } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  runOutsidePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
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
  fixturePluginId = "preflight-fixture",
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
      : [{ id: fixturePluginId, root: path.join(home, "fixture-plugin") }];
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
    // Seed canonical state independently of startup's derived registry write.
    openOpenClawStateDatabase({ env: process.env });
    await run(writeVersion, config, workspaces);
  });
}

const readPluginPreflight = () =>
  readConfigPreflightSnapshot({
    allowCurrentPluginMetadata: true,
    includePluginMetadata: true,
    preparePluginMetadataSnapshot: true,
    skipPluginValidation: false,
    observe: false,
  });

describe("startup plugin persistence", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    { scope: "process", replaceBeforeLease: false, independentWriter: false },
    { scope: "operation", replaceBeforeLease: false, independentWriter: false },
    { scope: "operation", replaceBeforeLease: true, independentWriter: false },
    { scope: "operation", replaceBeforeLease: false, independentWriter: true },
    { scope: "operation", replaceBeforeLease: true, independentWriter: true },
  ])(
    "verifies a persisted registry in the $scope scope (replacement before lease: $replaceBeforeLease, independent writer: $independentWriter)",
    async ({ scope, replaceBeforeLease, independentWriter }) => {
      await withPreflightPluginFixture(async (writeVersion) => {
        const run = async () => {
          const owner = getPluginCache();
          const read = readPluginPreflight;
          const initial = await read();
          expect(initial.pluginMetadataSnapshot?.registrySource).toBe("derived");
          expect(
            initial.pluginMetadataSnapshot?.manifestRegistry.plugins.map((p) => p.id),
          ).toContain("preflight-fixture");
          const siblingLease = replaceBeforeLease
            ? await migrationCheckpoint.acquireStartupMigrationLeaseWithWait({ timeoutMs: 0 })
            : undefined;
          let replaced = false;
          try {
            const preflight = () =>
              runStartupConfigPreflight({
                gateway: true,
                observe: false,
                beforeStatePreparation: async () => {
                  if (siblingLease && !replaced) {
                    // Commit after the initial read, before preflight acquires its lease.
                    replaced = true;
                    await writeVersion("2.0.0");
                    const replace = () =>
                      withPluginCache(createPluginCache(), async () => {
                        const latest = await read();
                        expect(latest.pluginMetadataSnapshot).toBeDefined();
                        writePersistedInstalledPluginIndexWithLeaseSync(
                          latest.pluginMetadataSnapshot!.index,
                          {
                            env: process.env,
                            lease: siblingLease,
                          },
                        );
                      });
                    await (independentWriter ? runOutsidePluginCache(replace) : replace());
                    siblingLease.release();
                  }
                  return true;
                },
              });
            const result = await (independentWriter
              ? runOutsidePluginCache(() => withPluginCache(createPluginCache(), preflight))
              : preflight());
            expect(result.pluginMetadataSnapshot?.registrySource).toBe("persisted");
            expect(
              result.pluginMetadataSnapshot?.manifestRegistry.plugins.find(
                (p) => p.id === "preflight-fixture",
              )?.version,
            ).toBe(replaceBeforeLease ? "2.0.0" : "1.0.0");
            if (scope === "operation") {
              expect(getPluginCache()).toBe(owner);
              const retained = (await read()).pluginMetadataSnapshot!;
              expect(getPluginMetadataSnapshotCache(retained)).toBe(owner);
              expect(retained.registrySource).toBe(independentWriter ? "derived" : "persisted");
              expect(
                retained.manifestRegistry.plugins.find((p) => p.id === "preflight-fixture")
                  ?.version,
              ).toBe(!independentWriter && replaceBeforeLease ? "2.0.0" : "1.0.0");
            }
          } finally {
            siblingLease?.release();
            // A failed selector reread must neither leak the lease nor hide a successful write.
            expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
              false,
            );
            const durable = withPluginCache(createPluginCache(), () =>
              readPersistedInstalledPluginIndexSync({ env: process.env }),
            );
            expect(durable?.plugins.map((p) => p.pluginId)).toContain("preflight-fixture");
          }
        };
        if (scope === "operation") {
          await withPluginCache(createPluginCache(), run);
        } else {
          await run();
        }
      });
    },
  );

  it("refreshes an invalidated Doctor scope without replacing the invoking generation", async () => {
    await withPreflightPluginFixture(async (writeVersion) => {
      const owner = createPluginCache();
      await withPluginCache(owner, async () => {
        const initial = await readPluginPreflight();
        let baseSnapshot = initial.pluginMetadataSnapshot;
        const config = initial.snapshot.sourceConfig;
        const scope = createDoctorPluginMetadataSnapshotScope({
          getBaseSnapshot: () => baseSnapshot,
        });
        const readVersion = () =>
          scope.run(
            { config },
            () =>
              getCurrentPluginMetadataSnapshot({ config })?.manifestRegistry.plugins.find(
                (plugin) => plugin.id === "preflight-fixture",
              )?.version,
          );
        expect(readVersion()).toBe("1.0.0");
        await writeVersion("2.0.0");
        expect(readVersion()).toBe("1.0.0");
        baseSnapshot = undefined;
        scope.invalidate();
        expect(readVersion()).toBe("2.0.0");
        expect(getPluginCache()).toBe(owner);
        const retained = (await readPluginPreflight()).pluginMetadataSnapshot!;
        expect(getPluginMetadataSnapshotCache(retained)).toBe(owner);
        expect(
          retained.manifestRegistry.plugins.find((p) => p.id === "preflight-fixture")?.version,
        ).toBe("1.0.0");
      });
    });
  });

  it.each(["beta"])(
    "reuses and persists the original %s scope while retaining the config-wide inventory",
    async (first) => {
      const names = [first, first === "alpha" ? "beta" : "alpha"];
      await withPreflightPluginFixture(async (writeVersion, config, workspaces) => {
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
            baseSnapshot: aggregate,
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
          // The invoking generation remains old; the post-lease read must own the written leaf.
          await writeVersion("2.0.0");
          const result = await preflight().catch((error: unknown) => error);
          expect.soft(result).not.toBeInstanceOf(Error);
          expect.soft(result).toMatchObject({
            pluginMetadataSnapshot: {
              registrySource: "persisted",
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
          expect.soft(durable?.workspaceDir).toBe(workspaces[first]);
          expect
            .soft(
              durable?.plugins
                .filter((p) => p.pluginId.startsWith("preflight-"))
                .map((p) => p.pluginId),
            )
            .toEqual([`preflight-${first}`]);
          expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
            false,
          );

          // Discriminating control: the exact original leaf is accepted by the same selector/preflight.
          const leaf = withPluginCache(createPluginCache(), () =>
            resolvePluginMetadataSnapshot({
              config,
              env: process.env,
              workspaceDir: workspaces[first],
              allowCurrent: false,
            }),
          );
          const lease = await migrationCheckpoint.acquireStartupMigrationLeaseWithWait({
            timeoutMs: 0,
          });
          try {
            runOutsidePluginCache(() =>
              withPluginCache(createPluginCache(), () =>
                writePersistedInstalledPluginIndexWithLeaseSync(leaf.index, {
                  env: process.env,
                  lease,
                }),
              ),
            );
          } finally {
            lease.release();
          }
          const control = await preflight();
          expect(control.pluginMetadataSnapshot?.registrySource).toBe("persisted");
          expect(
            control.pluginMetadataSnapshot?.plugins
              .filter((p) => p.id.startsWith("preflight-"))
              .map((p) => p.id)
              .toSorted(),
          ).toEqual(["preflight-alpha", "preflight-beta"]);
          expect(
            (await readPluginPreflight()).pluginMetadataSnapshot?.plugins.find(
              (p) => p.id === `preflight-${first}`,
            )?.version,
          ).toBe("1.0.0");
        });
      }, names);
    },
  );

  it.each(["secondary-schema", "duplicate-owner"])(
    "keeps full config-wide validation before persistence (%s)",
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
          allowCurrentPluginMetadata: false,
          includePluginMetadata: true,
          preparePluginMetadataSnapshot: true,
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

  it.each(["derived", "persisted"])(
    "returns current package facts without migrating discovery policy from a %s registry",
    async (initialSource) => {
      await withPreflightPluginFixture(async (writeVersion, config) => {
        const original = await readPluginPreflight();
        // Disabled plugins remain discoverable without executing their runtime entry.
        config.plugins!.entries = { "preflight-fixture": { enabled: false } };
        await fs.writeFile(original.snapshot.path, JSON.stringify(config));
        await withPluginCache(createPluginCache(), async () => {
          const initial = await readPluginPreflight();
          expect(initial.snapshot.valid).toBe(true);
          expect(initial.pluginMetadataSnapshot?.registrySource).toBe("derived");
          expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
          if (initialSource === "persisted") {
            const lease = await migrationCheckpoint.acquireStartupMigrationLeaseWithWait({
              timeoutMs: 0,
            });
            try {
              writePersistedInstalledPluginIndexWithLeaseSync(
                initial.pluginMetadataSnapshot!.index,
                { env: process.env, lease },
              );
            } finally {
              lease.release();
            }
          }
          const policyHash = resolveInstalledPluginIndexPolicyHash(config, process.env);
          await writeVersion("2.0.0");
          const result = await runStartupConfigPreflight({ gateway: true, observe: false });
          expect(result.snapshot.valid).toBe(true);
          expect(result.snapshot.raw).toBe(initial.snapshot.raw);
          expect(await fs.readFile(result.snapshot.path, "utf8")).toBe(initial.snapshot.raw);
          expect(result.baseConfig).toEqual(initial.snapshot.sourceConfig);
          expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
          expect(resolveInstalledPluginIndexPolicyHash(config, process.env)).toBe(policyHash);
          expect(result.pluginMetadataSnapshot?.registrySource).toBe("persisted");
          expect(
            result.pluginMetadataSnapshot?.plugins.find(
              (plugin) => plugin.id === "preflight-fixture",
            )?.version,
          ).toBe("2.0.0");
          const durable = withPluginCache(createPluginCache(), () =>
            readPersistedInstalledPluginIndexSync({ env: process.env }),
          );
          expect(durable?.policyHash).toBe(policyHash);
          expect(
            durable?.plugins.find((plugin) => plugin.pluginId === "preflight-fixture")
              ?.packageVersion,
          ).toBe("2.0.0");
          expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
            false,
          );
        });
      });
    },
  );

  it("refuses startup when package facts change before the durable reread", async () => {
    const fixturePluginId = "preflight-\u001b[31mfixture";
    await withPreflightPluginFixture(
      async (writeVersion) => {
        let changed = false;
        let failure: unknown;
        try {
          await runStartupConfigPreflight({
            gateway: true,
            observe: false,
            measure: async (name, operation) => {
              const result = await operation();
              if (name === "plugin-index-persistence") {
                changed = true;
                await writeVersion("2.0.0");
              }
              return result;
            },
          });
        } catch (error) {
          failure = error;
        }
        expect(changed).toBe(true);
        if (!(failure instanceof Error)) {
          throw new Error("expected plugin registry persistence to fail", { cause: failure });
        }
        expect(failure.message).toMatch(
          /differences: preflight-fixture \(record changed; persisted source: .*fixture-plugin.*derived source: .*fixture-plugin.*openclaw plugins registry --refresh/u,
        );
        expect(failure.message).not.toContain("\u001b");
        expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
          false,
        );
      },
      [],
      fixturePluginId,
    );
  });

  it.each([false, true])(
    "leaves migration stamps absent after durable verification (interrupted: %s)",
    async (interrupted) => {
      await withPreflightPluginFixture(async () => {
        let persisted = false;
        let verified = false;
        const readMigrationStamp = () => {
          const { db } = openOpenClawStateDatabase({ env: process.env });
          const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "schema_meta">>(db);
          return executeSqliteQueryTakeFirstSync(
            db,
            kysely
              .selectFrom("schema_meta")
              .select("app_version")
              .where("meta_key", "in", ["state-migrations", "startup-migrations"]),
          );
        };
        expect(readMigrationStamp()).toBeUndefined();
        const operation = runStartupConfigPreflight({
          gateway: true,
          observe: false,
          measure: async (name, run) => {
            const result = await run();
            if (name === "plugin-index-persistence") {
              persisted = true;
            }
            return result;
          },
          beforeStatePreparation: async () => {
            if (persisted) {
              const read = await readConfigPreflightSnapshot({
                allowCurrentPluginMetadata: false,
                includePluginMetadata: true,
                preparePluginMetadataSnapshot: true,
                skipPluginValidation: false,
                observe: false,
              });
              expect(read.pluginMetadataSnapshot?.registrySource).toBe("persisted");
              expect(readMigrationStamp()).toBeUndefined();
              verified = true;
              if (interrupted) {
                throw new Error("verification interrupted");
              }
            }
            return true;
          },
        });
        if (interrupted) {
          // Do not serialize the snapshot's captured environment if startup unexpectedly succeeds.
          await expect(operation.then(() => undefined)).rejects.toThrow("verification interrupted");
        } else {
          const result = await operation;
          expect(result.pluginMetadataSnapshot?.registrySource).toBe("persisted");
        }
        expect(verified).toBe(true);
        expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
          false,
        );
        expect(readMigrationStamp()).toBeUndefined();
        const durable = withPluginCache(createPluginCache(), () =>
          readPersistedInstalledPluginIndexSync({ env: process.env }),
        );
        expect(durable?.plugins.map((plugin) => plugin.pluginId)).toContain("preflight-fixture");
      });
    },
  );
});
