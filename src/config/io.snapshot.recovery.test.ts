import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import { acquireStartupMigrationLeaseWithWait } from "../infra/startup-migration-checkpoint.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";
import * as health from "./io.health-state.js";
import { createRecoveryConfigEnv } from "./io.observe-recovery.test-support.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";
import type { ConfigIoFactoryOptions } from "./io.types.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const failure = (message: string, code: string) => Object.assign(new Error(message), { code });
const promises = (overrides: Partial<typeof fs.promises>) => ({
  fs: { ...fs, promises: { ...fs.promises, ...overrides } },
});

function fixture(options: ConfigIoFactoryOptions = {}) {
  const root = dirs.make("openclaw-prepared-config-recovery-");
  const configPath = path.join(root, "openclaw.json");
  const original = '{ "update": { "channel": "beta" } }\n';
  const backup = JSON.stringify({
    gateway: { mode: "local", port: 18720 },
    env: { vars: { RECOVERY_MARKER: "backup" } },
  });
  fs.writeFileSync(configPath, original);
  fs.writeFileSync(`${configPath}.bak`, backup);
  const env = createRecoveryConfigEnv(root, configPath, root);
  const databasePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const deps = normalizeConfigIoDeps({
    env,
    homedir: () => root,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  const create = (extra: ConfigIoFactoryOptions = {}) =>
    createConfigIO({ ...deps, configPath, observe: false, ...extra });
  const io = create(options);
  const read = (suffix = "") => fs.readFileSync(`${configPath}${suffix}`, "utf8");
  const archives = () =>
    fs.readdirSync(root).filter((name) => name.startsWith("openclaw.json.clobbered."));
  const archived = () => {
    const files = archives();
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, files[0]!), "utf8")).toBe(original);
  };
  return {
    root,
    configPath,
    original,
    backup,
    databasePath,
    env,
    deps,
    io,
    create,
    read,
    archives,
    archived,
    manifest: () =>
      listDirectoryTreeStrictSync(root)
        .map(({ relativePath }) => relativePath)
        .toSorted()
        .filter((entry) => fs.statSync(path.join(root, entry)).isFile())
        .map((entry) => [
          entry,
          createHash("sha256")
            .update(fs.readFileSync(path.join(root, entry)))
            .digest("hex"),
        ]),
    unchanged: (checkBackup = true) => {
      expect(read()).toBe(original);
      expect(archives()).toEqual([]);
      if (checkBackup) {
        expect(read(".bak")).toBe(backup);
      }
    },
    recovered: () => {
      expect(read()).toBe(backup);
      archived();
    },
    storedHealth: () => health.readConfigHealthStateFromStore(deps),
  };
}

async function prepare(io: ReturnType<typeof createConfigIO>) {
  return io.prepareConfigRecovery(
    await withArtifactPreservingStateReads(() => io.readConfigFileSnapshot()),
  );
}
async function recovery(io: ReturnType<typeof createConfigIO>) {
  const plan = await prepare(io);
  if (!plan) {
    throw new Error("Expected a prepared recovery");
  }
  return plan;
}

function backupFailure(phase: string, currentError: () => Error | undefined) {
  const guard = <F extends (...args: never[]) => unknown>(
    fn: F,
    boundary: string,
    async = false,
  ): F =>
    new Proxy(fn, {
      apply(target, self, args) {
        const error =
          String(args[0]).endsWith(".bak") &&
          (phase === boundary || (phase === "stat" && boundary.endsWith("stat"))) &&
          currentError();
        if (error) {
          if (async) {
            return Promise.reject(error);
          }
          throw error;
        }
        return Reflect.apply(target, self, args);
      },
    });
  return {
    fs: {
      ...fs,
      readFileSync: guard(fs.readFileSync, "sync-read"),
      statSync: guard(fs.statSync, "sync-stat"),
      promises: {
        ...fs.promises,
        readFile: guard(fs.promises.readFile, "async-read", true),
        stat: guard(fs.promises.stat, "async-stat", true),
      },
    },
  };
}

it.each(["absent", "unparseable", "externally-owned"])("declines %s recovery", async (kind) => {
  const f = fixture();
  if (kind === "absent") {
    fs.unlinkSync(`${f.configPath}.bak`);
  } else if (kind === "unparseable") {
    fs.writeFileSync(`${f.configPath}.bak`, "{ not JSON5");
  } else {
    f.io.env.OPENCLAW_CONFIG_READONLY = "1";
  }
  const before = kind === "externally-owned" ? f.manifest() : undefined;
  await expect(prepare(f.io)).resolves.toBeNull();
  f.unchanged(false);
  if (kind === "unparseable") {
    expect(f.read(".bak")).toBe("{ not JSON5");
  }
  if (kind === "externally-owned") {
    expect(f.manifest()).toEqual(before);
  }
});

it.each(["sync-read", "sync-stat", "async-read", "async-stat"])(
  "preserves %s backup I/O errors",
  async (phase) => {
    const error = failure("backup device unavailable", "EIO");
    let armed = false;
    const f = fixture(backupFailure(phase, () => (armed ? error : undefined)));
    const plan = phase.startsWith("async") ? undefined : await recovery(f.io);
    armed = true;
    await expect(plan ? plan.apply() : prepare(f.io)).rejects.toBe(error);
    f.unchanged();
  },
);

it("preserves unavailable full backup validation", async () => {
  let validations = 0;
  const f = fixture({
    measure: async (name, run) => {
      if (name === "config.snapshot.read.validate" && ++validations === 2) {
        throw failure("backup validation storage unavailable", "EIO");
      }
      return await run();
    },
  });
  await expect(prepare(f.io)).rejects.toMatchObject({ code: "CONFIG_READ_FAILED" });
  f.unchanged();
});

it.each(["completed", "during-apply"])("preserves newer %s health metadata", async (phase) => {
  const f = fixture();
  const plan = await recovery(f.io);
  if (phase === "completed") {
    observeConfigSnapshotSync(f.deps, await f.io.readConfigFileSnapshot());
  }
  const before = phase === "completed" ? f.storedHealth() : undefined;
  await plan.apply(
    phase === "during-apply"
      ? () =>
          health.patchConfigHealthEntryToStore(f.deps, f.configPath, {
            lastObservedSuspiciousSignature: "newer-observation",
          })
      : undefined,
  );
  f.recovered();
  if (before) {
    expect(f.storedHealth()).toEqual(before);
  } else {
    expect(f.storedHealth().entries?.[f.configPath]?.lastObservedSuspiciousSignature).toBe(
      "newer-observation",
    );
  }
});

it.each(["async", "sync"])(
  "%s ordinary recovery tolerates unavailable backup stat",
  async (mode) => {
    const f = fixture({
      observe: undefined,
      ...backupFailure("stat", () => failure("EACCES: stat denied", "EACCES")),
    });
    const recovered =
      mode === "async"
        ? (await f.io.readConfigFileSnapshot({ recoverSuspicious: true })).config
        : f.io.loadConfig();
    expect(recovered.gateway?.mode).toBe("local");
    expect(f.read()).toBe(f.backup);
  },
);

it("keeps prepared recovery available without health reads", async () => {
  const capture = health.captureConfigHealthStateStore;
  vi.spyOn(health, "captureConfigHealthStateStore").mockImplementation((...args) => ({
    ...capture(...args),
    read: async () => ({ state: {}, basis: null }),
  }));
  const f = fixture();
  await (await recovery(f.io)).apply();
  f.recovered();
  expect(f.storedHealth().entries?.[f.configPath]).toBeUndefined();
});

it.each(["full", "core-only"] as const)(
  "previews %s without writes and restores admitted bytes",
  async (pluginValidation) => {
    const f = fixture({ pluginValidation });
    expect(fs.existsSync(`${f.databasePath}-wal`)).toBe(false);
    const before = f.manifest();
    const plan = await recovery(f.io);
    expect(plan.snapshot).toMatchObject({
      raw: f.backup,
      path: f.configPath,
      valid: true,
      config: {
        gateway: { mode: "local", port: 18720 },
        agents: { defaults: { compaction: { mode: "safeguard" } } },
      },
    });
    expect(f.env).not.toHaveProperty("RECOVERY_MARKER");
    expect(f.manifest()).toEqual(before);
    await plan.apply();
    f.recovered();
    expect((await f.io.readConfigFileSnapshotWithPluginMetadata()).snapshot).toEqual(plan.snapshot);
  },
);

it("refuses replaced backup identity before any write", async () => {
  const f = fixture();
  const plan = await recovery(f.io);
  const replacement = path.join(f.root, "replacement");
  fs.writeFileSync(replacement, f.backup);
  fs.renameSync(replacement, `${f.configPath}.bak`);
  const before = f.manifest();
  await expect(plan.apply()).rejects.toThrow("config recovery source changed since preparation");
  expect(f.manifest()).toEqual(before);
});

it.each(["backup", "lease"])("refuses %s changes during archival", async (changedSource) => {
  const f = fixture();
  const lease =
    changedSource === "lease"
      ? await acquireStartupMigrationLeaseWithWait({ env: f.env, timeoutMs: 0 })
      : undefined;
  const concurrentRaw = '{ "gateway": { "mode": "local", "port": 18721 } }\n';
  const io = f.create(
    promises({
      writeFile: async (filename, data, options) => {
        await fs.promises.writeFile(filename, data, options);
        if (typeof filename === "string" && filename.startsWith(`${f.configPath}.clobbered.`)) {
          if (lease) {
            lease.release();
          } else {
            await fs.promises.writeFile(`${f.configPath}.bak`, concurrentRaw);
          }
        }
      },
    }),
  );
  const plan = await recovery(io);
  await expect(plan.apply(lease?.heartbeat)).rejects.toThrow(
    lease ? "startup migration lease was lost" : "config recovery source changed since preparation",
  );
  if (!lease) {
    expect(f.read(".bak")).toBe(concurrentRaw);
  }
  expect(f.read()).toBe(f.original);
  f.archived();
});

it.each(["archive", "replacement"])("preserves config after failed %s", async (stage) => {
  const f = fixture();
  const warn = vi.fn();
  const io = f.create({
    logger: { warn, error: vi.fn() },
    ...promises({
      writeFile: async (filename, data, options) => {
        if (
          stage === "archive" &&
          typeof filename === "string" &&
          filename.includes(".clobbered.")
        ) {
          throw failure("snapshot disk full", "ENOSPC");
        }
        return fs.promises.writeFile(filename, data, options);
      },
      rename: async (source, target) => {
        if (stage === "replacement" && target === f.configPath) {
          throw failure("recovery replacement denied", "EACCES");
        }
        await fs.promises.rename(source, target);
      },
    }),
  });
  await expect((await recovery(io)).apply()).rejects.toThrow(
    stage === "archive" ? "Config backup recovery deferred" : "recovery replacement denied",
  );
  if (stage === "archive") {
    f.unchanged();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("recovery deferred"));
  } else {
    expect(f.read()).toBe(f.original);
    expect(f.archives()).toHaveLength(1);
  }
});
