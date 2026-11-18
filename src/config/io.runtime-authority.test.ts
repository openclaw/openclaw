import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import {
  activateSecretsRuntimeSnapshot as activateSecrets,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot as prepareSecrets,
  preflightActiveSecretsRuntimeSnapshotRefresh as preflightSecrets,
  refreshActiveSecretsRuntimeSnapshotForConfig as refreshSecrets,
} from "../secrets/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withExecutor } from "./config-executor.test-support.js";
import * as factory from "./io.factory.js";
import { writeConfigFile } from "./io.runtime.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot as getRuntime,
  registerRuntimeConfigWriteListener,
  registerManagedRuntimeConfigWriteOwner as manageWrites,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler as setRefreshHandler,
} from "./runtime-snapshot.js";
import { withTempHome } from "./test-helpers.js";
import { withConfigWriteLock as withWriteLock } from "./write-lock.js";

const oldConfig = { gateway: { mode: "local" as const, port: 18789 } };
const nextConfig = { gateway: { mode: "local" as const, port: 19001 } };
async function activate(config: Parameters<typeof prepareSecrets>[0]["config"] = oldConfig) {
  activateSecrets(
    await prepareSecrets({
      config,
      env: {},
      includeConfigRefs: false,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    }),
  );
}
const roots = createSuiteTempRootTracker({ prefix: "config-authority-coordinator-" });
beforeAll(async () => await roots.setup());
beforeEach(async () => {
  vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    await roots.make("coordinator"),
  );
});
afterAll(async () => await roots.cleanup());
afterEach(() => {
  vi.restoreAllMocks();
  clearSecretsRuntimeSnapshot();
  setRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
});

it.each(
  ["canonical", "refresh", "deferred", "secrets"]
    .map((boundary) => `explicit:${boundary}`)
    .concat("ambient:canonical", "direct:cached", "direct:uncached")
    .flatMap((mode) => [false, true].map((revoke) => ({ mode, revoke }))),
)("$mode retains original authority (revoke=$revoke)", async ({ mode, revoke }) => {
  await withTempHome((home) =>
    withExecutor(home, "config-finalization-fence", async (assertCurrent, revokeExecutor) => {
      const [authority, boundary] = mode.split(":");
      if (authority === "direct") {
        await activate();
        const cached = boundary === "cached";
        const preflightResult = cached
          ? await preflightSecrets({ sourceConfig: nextConfig })
          : undefined;
        const params = { sourceConfig: nextConfig, preflightResult, assertCurrent };
        if (revoke && cached) {
          revokeExecutor();
        }
        const pending = refreshSecrets(params);
        if (revoke && !cached) {
          // Revoke during preparation, before synchronous compare-and-activate.
          revokeExecutor();
        }
        if (revoke) {
          await expect(pending).rejects.toBeInstanceOf(Error);
        } else {
          await expect(pending).resolves.toBe(true);
        }
        expect(getRuntime()?.gateway?.port).toBe(revoke ? 18789 : 19001);
        return;
      }
      const file = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(oldConfig) + "\n");
      const env = { ...process.env, OPENCLAW_CONFIG_PATH: file };
      const io = factory.createConfigIO({ env, observe: false, pluginValidation: "skip" });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
      const atBoundary = vi.fn(revoke ? revokeExecutor : undefined);
      const clearOnFailure = vi.fn();
      const releaseOwner = boundary === "deferred" ? manageWrites(file) : () => {};
      if (boundary === "canonical" || boundary === "deferred") {
        const createIO = factory.createConfigIO;
        vi.spyOn(factory, "createConfigIO").mockImplementation((options) => {
          const realIO = createIO(options);
          return {
            ...realIO,
            readConfigFileSnapshotForWrite: async (readOptions) => {
              const actual = await realIO.readConfigFileSnapshotForWrite(readOptions);
              atBoundary();
              return actual;
            },
          };
        });
      } else {
        const secrets = boundary === "secrets";
        if (secrets) {
          await activate(snapshot.config);
        }
        setRefreshHandler({
          refresh: async (params) => {
            const pending = secrets ? refreshSecrets(params) : false;
            if (!secrets) {
              await Promise.resolve();
            }
            atBoundary();
            return await pending;
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
        const pending =
          authority === "ambient" ? withWriteLock(file, write, env, assertCurrent) : write();
        if (revoke) {
          await expect(pending).rejects.toBeInstanceOf(Error);
          expect(assertCurrent).toThrow();
        } else {
          await pending;
          assertCurrent();
        }
        expect(atBoundary).toHaveBeenCalledTimes(1);
        expect(getRuntime()?.gateway?.port).toBe(revoke || boundary === "deferred" ? 18789 : 19001);
        expect(notified).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(clearOnFailure).not.toHaveBeenCalled();
        expect(JSON.parse(await fs.readFile(file, "utf8")).gateway.port).toBe(19001);
      } finally {
        unregister();
        releaseOwner();
      }
    }),
  );
});
