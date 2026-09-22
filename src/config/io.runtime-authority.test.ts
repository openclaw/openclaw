// Exercises the real update owner across successful config runtime finalization.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../infra/update-managed-service-handoff-database.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  preflightActiveSecretsRuntimeSnapshotRefresh,
  refreshActiveSecretsRuntimeSnapshotForConfig,
} from "../secrets/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as configFactory from "./io.factory.js";
import { writeConfigFile } from "./io.runtime.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  registerRuntimeConfigWriteListener,
  registerManagedRuntimeConfigWriteOwner,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { withTempHome } from "./test-helpers.js";
import { withConfigWriteLock } from "./write-lock.js";

async function withExecutor(
  home: string,
  consume: (assertCurrent: () => void, revoke: () => void) => Promise<void>,
) {
  const root = path.join(await fs.realpath(home), "package");
  await fs.mkdir(root);
  const databasePath = path.join(home, "control", "managed-update-handoffs.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  await withUpdateCommandExecutor(
    "config-finalization-fence",
    async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      await consume(fence.assertCurrent, () => releaseUpdateCommandPreflightForHandoff(fence));
    },
    {
      existingAuthority: {
        ...captureManagedUpdateLeaseDatabaseIdentity(databasePath),
        installKey: root,
      },
    },
  );
}

const oldConfig = { gateway: { mode: "local" as const, port: 18789 } };
const nextConfig = { gateway: { mode: "local" as const, port: 19001 } };

describe("runtime finalization retains original authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearSecretsRuntimeSnapshot();
    setRuntimeConfigSnapshotRefreshHandler(null);
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(
    (["explicit", "ambient"] as const).flatMap((authority) =>
      (["canonical", "refresh", "deferred", "secrets"] as const).flatMap((boundary) =>
        [false, true].map((revoke) => ({ authority, boundary, revoke })),
      ),
    ),
  )(
    "$authority write across $boundary (revoke=$revoke)",
    async ({ authority, boundary, revoke }) => {
      await withTempHome(async (home) =>
        withExecutor(home, async (assertCurrent, revokeExecutor) => {
          const configPath = path.join(home, ".openclaw", "openclaw.json");
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, `${JSON.stringify(oldConfig)}\n`);
          const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
          const io = configFactory.createConfigIO({
            env,
            observe: false,
            pluginValidation: "skip",
          });
          const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
          setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
          let reachedBoundary = 0;
          const atBoundary = () => {
            reachedBoundary++;
            if (revoke) {
              revokeExecutor();
            }
          };
          const clearOnFailure = vi.fn();
          const releaseManagedOwner =
            boundary === "deferred" ? registerManagedRuntimeConfigWriteOwner(configPath) : () => {};
          if (boundary === "canonical" || boundary === "deferred") {
            const createIO = configFactory.createConfigIO;
            vi.spyOn(configFactory, "createConfigIO").mockImplementation((options) => {
              const realIO = createIO(options);
              return {
                ...realIO,
                readConfigFileSnapshot: async () => {
                  const actual = await realIO.readConfigFileSnapshot();
                  atBoundary();
                  return actual;
                },
              };
            });
          } else if (boundary === "secrets") {
            activateSecretsRuntimeSnapshot(
              await prepareSecretsRuntimeSnapshot({
                config: snapshot.config,
                env: {},
                includeConfigRefs: false,
                includeAuthStoreRefs: false,
                loadablePluginOrigins: new Map(),
              }),
            );
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: async (params) => {
                const pending = refreshActiveSecretsRuntimeSnapshotForConfig(params);
                atBoundary();
                return await pending;
              },
              clearOnRefreshFailure: clearOnFailure,
            });
          } else {
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: async () => {
                await Promise.resolve();
                atBoundary();
                return false;
              },
              clearOnRefreshFailure: clearOnFailure,
            });
          }
          const notified = vi.fn();
          const unregister = registerRuntimeConfigWriteListener(notified);
          try {
            const write = () =>
              writeConfigFile(nextConfig, {
                ...writeOptions,
                baseSnapshot: snapshot,
                observe: false,
                skipPluginValidation: true,
                ...(authority === "explicit" ? { assertCurrent } : {}),
              });
            let failure: unknown;
            try {
              if (authority === "ambient") {
                await withConfigWriteLock(configPath, write, env, assertCurrent);
              } else {
                await write();
              }
            } catch (error) {
              failure = error;
            }
            expect(reachedBoundary).toBe(1);
            expect(getRuntimeConfigSnapshot()?.gateway?.port).toBe(
              revoke || boundary === "deferred" ? 18789 : 19001,
            );
            expect(notified).toHaveBeenCalledTimes(revoke ? 0 : 1);
            expect(clearOnFailure).not.toHaveBeenCalled();
            expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(19001);
            if (revoke) {
              expect(failure).toBeInstanceOf(Error);
              expect(() => assertCurrent()).toThrow();
            } else {
              expect(failure).toBeUndefined();
              assertCurrent();
            }
          } finally {
            unregister();
            releaseManagedOwner();
          }
        }),
      );
    },
  );

  it.each([false, true].flatMap((cached) => [false, true].map((revoke) => ({ cached, revoke }))))(
    "real secrets refresh retains owner across preparation (cached=$cached, revoke=$revoke)",
    async ({ cached, revoke }) => {
      await withTempHome(async (home) =>
        withExecutor(home, async (assertCurrent, revokeExecutor) => {
          const initial = await prepareSecretsRuntimeSnapshot({
            config: oldConfig,
            env: {},
            includeConfigRefs: false,
            includeAuthStoreRefs: false,
            loadablePluginOrigins: new Map(),
          });
          activateSecretsRuntimeSnapshot(initial);
          const preflightResult = cached
            ? await preflightActiveSecretsRuntimeSnapshotRefresh({ sourceConfig: nextConfig })
            : undefined;
          const params = { sourceConfig: nextConfig, preflightResult, assertCurrent };
          if (revoke && cached) {
            revokeExecutor();
          }
          const pending = refreshActiveSecretsRuntimeSnapshotForConfig(params);
          if (revoke && !cached) {
            // Preparation must await before the synchronous compare-and-activate effect.
            revokeExecutor();
          }
          let failure: unknown;
          let activated: boolean | undefined;
          try {
            activated = await pending;
          } catch (error) {
            failure = error;
          }
          expect(getRuntimeConfigSnapshot()?.gateway?.port).toBe(revoke ? 18789 : 19001);
          if (revoke) {
            expect(failure).toBeInstanceOf(Error);
            expect(activated).toBeUndefined();
          } else {
            expect(failure).toBeUndefined();
            expect(activated).toBe(true);
          }
        }),
      );
    },
  );
});
