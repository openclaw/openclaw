import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { startGatewayConfigReloader } from "../gateway/config-reload.js";
import { createWatcherMock } from "../gateway/config-reload.watcher.test-support.js";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withExecutor } from "./config-executor.test-support.js";
import { readLatestConfigSnapshotAuditRecordAsync } from "./config-journal-snapshot.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import { createConfigIO } from "./io.factory.js";
import { readConfigFileSnapshotForRuntimeTransaction } from "./io.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "./io.runtime.js";
import { createConfigIoWorkerFixture } from "./io.worker.test-support.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  type RuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import * as configFileSource from "./source-file.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";
import { withConfigWriteLock } from "./write-lock.js";

const original = '{"gateway":{"mode":"local","port":18789}}\n';
const nextConfig = { gateway: { mode: "local" as const, port: 19001 } };

async function prepareWrite(home: string, existed = true) {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (existed) {
    await fs.writeFile(configPath, original);
  }
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
  const io = createConfigIO({ env, observe: false, pluginValidation: "skip", homedir: () => home });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  const options = {
    ...writeOptions,
    baseSnapshot: snapshot,
    observe: false,
    skipPluginValidation: true,
  };
  return { configPath, env, io, snapshot, options };
}

function refuseRefresh(before: () => void = () => {}) {
  setRuntimeConfigSnapshotRefreshHandler({
    preflight: () => undefined,
    refresh: () => {
      before();
      throw new Error("runtime activation refused");
    },
  });
}

function expectPostCommitError(
  failure: unknown,
  configPath: string,
  rollbackStatus: string,
  reason = /runtime snapshot refresh failed/,
) {
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    name: "ConfigWritePostCommitError",
    configPath,
    rollbackStatus,
    message: expect.stringMatching(reason),
  });
}

const workerRoots = createSuiteTempRootTracker({ prefix: "openclaw-config-reread-workers-" });
const workers = createConfigIoWorkerFixture();
beforeAll(async () => {
  await workers.setup(await workerRoots.setup());
});
afterAll(async () => {
  await workers.close();
  await workerRoots.cleanup();
});

afterEach(() => {
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const log = { info: () => {}, warn: () => {}, error: () => {} };
const withJournal = (
  run: (io: ReturnType<typeof createConfigIO>, home: string, configPath: string) => Promise<void>,
) =>
  withTempHome(async (home) => {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const tmp = vi
      .spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(await fs.mkdtemp(path.join(home, "coordinator-")));
    try {
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.dirname(configPath),
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        () =>
          run(
            createConfigIO({
              configPath,
              env: process.env,
              homedir: () => home,
              observe: false,
              logger: log,
            }),
            home,
            configPath,
          ),
      );
    } finally {
      await closeOpenClawStateDatabaseAsync();
      tmp.mockRestore();
    }
  });
const latestSlot = (home: string) =>
  readLatestConfigSnapshotAuditRecordAsync({ env: process.env, homedir: () => home });
const externalRecords = (home: string) =>
  listConfigAuditRecordsForTests({ env: process.env, homedir: () => home }).filter(
    (record) => record.event === "config.external",
  );

async function reconcileStartup(snapshot: ConfigFileSnapshot) {
  const watcher = vi
    .spyOn(configFileSource, "createConfigFileAdapter")
    .mockImplementation((options) => createWatcherMock().attach(options));
  const reloader = startGatewayConfigReloader({
    scheduler: createTestGatewayScheduler(),
    initialConfig: snapshot.config,
    initialCompareConfig: snapshot.sourceConfig,
    initialSnapshotRawHash: snapshot.hash ?? null,
    initialAuthoredConfig: snapshot.parsed,
    initialSnapshotValid: snapshot.valid,
    initialSnapshotIssues: snapshot.issues,
    readSnapshot: async () => snapshot,
    initialPluginInstallRecords: {},
    readPluginInstallRecords: async () => ({}),
    onNoopConfigCommit: async () => {},
    onHotReload: async () => "applied" as const,
    onRestart: async () => {},
    log,
    watchPath: snapshot.path,
  });
  try {
    await reloader.ready;
  } finally {
    await reloader.stop();
    watcher.mockRestore();
  }
}

it("shares raw snapshot hashes between config writes and gateway startup reconciliation", async () => {
  await withJournal(async (io, home, configPath) => {
    openOpenClawStateDatabase({ env: process.env });
    using prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const write = await io.writeConfigFile({ gateway: { port: 18789 } });
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("diagnostic_events"))).toEqual([]);
    const writtenSnapshot = await readConfigFileSnapshotForRuntimeTransaction({});
    expect(writtenSnapshot).toMatchObject({ valid: true, hash: write.persistedHash });
    expect(await latestSlot(home)).toMatchObject({ rawHash: write.persistedHash });
    await reconcileStartup(writtenSnapshot);
    expect(externalRecords(home)).toEqual([]);
    const handEditedAuthoredConfig = structuredClone(writtenSnapshot.parsed) as OpenClawConfig;
    handEditedAuthoredConfig.gateway = { ...handEditedAuthoredConfig.gateway, port: 18790 };
    await fs.writeFile(configPath, `${JSON.stringify(handEditedAuthoredConfig, null, 2)}\n`);
    const handEditedSnapshot = await readConfigFileSnapshotForRuntimeTransaction({});
    await reconcileStartup(handEditedSnapshot);
    expect(externalRecords(home).at(-1)).toMatchObject({
      event: "config.external",
      detectedBy: "startup",
      previousHash: write.persistedHash,
      nextHash: handEditedSnapshot.hash,
      changedPaths: ["gateway.port"],
      valid: true,
    });
  });
});

it("reseeds a shared state slot when the gateway starts for another config path", async () => {
  await withJournal(async (io, home) => {
    const configPathB = path.join(home, ".openclaw", "config-b.json");
    await io.writeConfigFile({ gateway: { port: 18789 } });
    await fs.writeFile(configPathB, `${JSON.stringify({ gateway: { port: 18790 } }, null, 2)}\n`);
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPathB }, async () => {
      const snapshot = await readConfigFileSnapshotForRuntimeTransaction({});
      await reconcileStartup(snapshot);
      expect(externalRecords(home)).toEqual([]);
      expect(await latestSlot(home)).toMatchObject({
        configPath: configPathB,
        rawHash: snapshot.hash,
      });
    });
  });
});

it("preserves committed source provenance when the post-write reread is invalid", async () => {
  await withTempHome(async (home) => {
    const configPath = await writeOpenClawConfig(home, {
      gateway: { mode: "local", port: 18789 },
      agents: { entries: { main: {} }, defaults: { compaction: {} } },
    });

    // Corrupt only the post-commit reread, keeping the persisted payload inspectable.
    let corrupted = false;
    const realRename = fsNode.renameSync;
    vi.spyOn(fsNode, "renameSync").mockImplementation((from, to) => {
      realRename(from, to);
      if (to === configPath) {
        corrupted = true;
      }
    });
    const realReadFileSync = fsNode.readFileSync.bind(fsNode);
    vi.spyOn(fsNode, "readFileSync").mockImplementation(
      new Proxy(realReadFileSync, {
        apply(read, receiver, args) {
          return corrupted && args[0] === configPath
            ? "{ definitely not json"
            : Reflect.apply(read, receiver, args);
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const preflight = vi.fn<NonNullable<RuntimeConfigSnapshotRefreshHandler["preflight"]>>(
      ({ sourceConfig }) => ({ sourceConfig }),
    );
    const refresh = vi.fn<RuntimeConfigSnapshotRefreshHandler["refresh"]>(async () => true);
    setRuntimeConfigSnapshotRefreshHandler({ preflight, refresh });

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
      await writeConfigFile({
        ...snapshot.config,
        gateway: { mode: "local", port: 19001 },
      });
    });

    const persisted: unknown = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(persisted).toHaveProperty("agents.defaults.compaction", {});
    expect(preflight).toHaveBeenCalledExactlyOnceWith({ sourceConfig: persisted });
    expect(refresh).toHaveBeenCalledExactlyOnceWith({
      sourceConfig: persisted,
      preflightResult: { sourceConfig: persisted },
      assertCurrent: expect.any(Function),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("canonical reread after write was invalid"),
    );
  });
});

it.each([
  { existed: false, revoke: false },
  { existed: true, revoke: false },
  { existed: true, revoke: true },
])(
  "rechecks compensation authority after reading the committed file (existed=$existed, revoke=$revoke)",
  async ({ existed, revoke }) => {
    await withTempHome(async (home) =>
      withExecutor(home, "config-compensation-fence", async (assertCurrent, revokeExecutor) => {
        const { configPath, env, options } = await prepareWrite(home, existed);
        const auditSnapshot = () =>
          readLatestConfigSnapshotAuditRecordAsync({ env, homedir: () => home });
        const beforeAuditSnapshot = await auditSnapshot();
        let compensating = false;
        let committedRaw: string | Buffer | undefined;
        const readFile = fsNode.promises.readFile.bind(fsNode.promises);
        vi.spyOn(fsNode.promises, "readFile").mockImplementation(async (...args) => {
          const raw = await readFile(...args);
          if (compensating && args[0] === configPath && committedRaw === undefined) {
            committedRaw = raw;
            if (revoke) {
              revokeExecutor();
            }
          }
          return raw;
        });
        refuseRefresh(() => {
          compensating = true;
        });

        const { failure, hash } = await captureUpdateDoctorConfigWrites(
          configPath,
          async (capture) => ({
            failure: await writeConfigFile(nextConfig, { ...options, assertCurrent }).catch(
              (error: unknown) => error,
            ),
            hash: capture.hash,
          }),
        );
        expectPostCommitError(failure, configPath, revoke ? "unknown" : "restored");

        expect(committedRaw).toBeDefined();
        if (revoke) {
          expect(await fs.readFile(configPath, "utf8")).toBe(committedRaw);
          expect(JSON.parse(String(committedRaw)).gateway.port).toBe(19001);
        } else {
          expect(failure).not.toHaveProperty("message", expect.stringContaining("Rollback failed"));
          expect(await auditSnapshot()).toEqual(beforeAuditSnapshot);
          if (existed) {
            await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
          } else {
            await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
        expect(hash).toBe(hashConfigRaw(revoke ? String(committedRaw) : existed ? original : null));
      }),
    );
  },
);

it.each([
  { writer: "direct", authority: "ordinary" },
  { writer: "runtime", authority: "ambient" },
] as const)(
  "restores through guarded copy fallback for $writer writes with $authority authority",
  async ({ writer, authority }) => {
    await withTempHome(async (home) => {
      const { configPath, env, io, options } = await prepareWrite(home);
      const priorAudit =
        writer === "direct"
          ? listConfigAuditRecordsForTests({ env: io.env, homedir: () => home })
          : undefined;
      let committed = false;
      let compensationDenied = false;
      const renameSync = fsNode.renameSync;
      vi.spyOn(fsNode, "renameSync").mockImplementation((source, destination) => {
        if (destination === configPath && committed) {
          compensationDenied = true;
          throw Object.assign(new Error("compensation rename denied"), { code: "EPERM" });
        }
        renameSync(source, destination);
        if (destination === configPath) {
          committed = true;
          if (writer === "direct") {
            env.OPENCLAW_CONFIG_PATH = `${configPath}.replacement`;
          }
        }
      });
      if (writer !== "direct") {
        refuseRefresh();
      }
      const write = async () => {
        const pending =
          writer === "direct"
            ? io.writeConfigFile(nextConfig, options)
            : writeConfigFile(nextConfig, options);
        const failure = await pending.catch((error: unknown) => error);
        expectPostCommitError(
          failure,
          configPath,
          "restored",
          writer === "direct" ? /config path changed/ : /runtime snapshot refresh failed/,
        );
        if (writer === "direct") {
          expect(failure).toHaveProperty("cause", expect.any(ConfigMutationConflictError));
          expect(failure).toMatchObject({
            cause: { message: "config path changed since last load", retryable: false },
          });
          expect(listConfigAuditRecordsForTests({ env: io.env, homedir: () => home })).toEqual(
            priorAudit,
          );
        }
      };
      if (authority === "ordinary") {
        await write();
      } else {
        await withExecutor(home, "config-compensation-fence", async (assertCurrent) => {
          await withConfigWriteLock(configPath, write, env, assertCurrent);
        });
      }
      expect(compensationDenied).toBe(true);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    });
  },
);

it.each(["same-byte-replacement", "revoked"] as const)(
  "fences direct root compensation after %s",
  async (fault) => {
    await withTempHome(async (home) =>
      withExecutor(home, "config-compensation-fence", async (assertCurrent, revokeExecutor) => {
        const { configPath, io, options } = await prepareWrite(home);
        const realRename = fsNode.renameSync;
        let rootRenames = 0;
        const mutations = (["writeSync", "writeFileSync", "ftruncateSync", "rmSync"] as const).map(
          (name) => vi.spyOn(fsNode, name),
        );
        const opens = vi.spyOn(fsNode, "openSync");
        let observed: { raw: string; ino: bigint; counts: number[] } | undefined;
        const targetsConfig = (target: fsNode.PathLike | number, callOrder: number) => {
          if (typeof target !== "number") {
            return String(target) === configPath;
          }
          const openedAt = opens.mock.results.findLastIndex(
            (result, index) =>
              result.type === "return" &&
              result.value === target &&
              opens.mock.invocationCallOrder[index]! < callOrder,
          );
          return openedAt >= 0 && String(opens.mock.calls[openedAt]?.[0]) === configPath;
        };
        // Worker lock custody can advance independently of the fenced config target.
        const effects = () => [
          rootRenames,
          ...mutations.map(
            ({ mock }) =>
              mock.calls.filter((args, index) =>
                targetsConfig(args[0], mock.invocationCallOrder[index]!),
              ).length,
          ),
          opens.mock.calls.filter(
            ([target, flags]) =>
              String(target) === configPath &&
              (typeof flags === "number"
                ? Boolean(flags & (fsNode.constants.O_WRONLY | fsNode.constants.O_RDWR))
                : /[wa+]/.test(flags)),
          ).length,
        ];
        vi.spyOn(fsNode, "renameSync").mockImplementation((source, destination) => {
          realRename(source, destination);
          if (destination !== configPath) {
            return;
          }
          rootRenames++;
          if (observed) {
            return;
          }
          const raw = fsNode.readFileSync(configPath, "utf8");
          const ownedInode = fsNode.lstatSync(configPath, { bigint: true }).ino;
          if (fault === "same-byte-replacement") {
            // Preserve the original inode so allocating its replacement cannot reuse it.
            realRename(configPath, `${configPath}.owned`);
            fsNode.writeFileSync(configPath, raw);
            expect(fsNode.lstatSync(configPath, { bigint: true }).ino).not.toBe(ownedInode);
          } else {
            revokeExecutor();
          }
          observed = {
            raw,
            ino: fsNode.lstatSync(configPath, { bigint: true }).ino,
            counts: effects(),
          };
        });
        const failure = await io
          .writeConfigFile(nextConfig, { ...options, assertCurrent })
          .catch((error: unknown) => error);
        expect.soft(failure).toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "unknown",
        });
        if (!observed) {
          throw new Error("root publication fault was not reached");
        }
        expect(JSON.parse(observed.raw).gateway.port).toBe(19001);
        expect.soft(effects()).toEqual(observed.counts);
        expect.soft(await fs.readFile(configPath, "utf8")).toBe(observed.raw);
        expect.soft(fsNode.lstatSync(configPath, { bigint: true }).ino).toBe(observed.ino);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
      }),
    );
  },
);
