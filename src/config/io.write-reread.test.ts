import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withExecutor } from "./config-executor.test-support.js";
import { readLatestConfigSnapshotAuditRecordAsync } from "./config-journal-snapshot.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import { createConfigIO } from "./io.factory.js";
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
import { withTempHome } from "./test-helpers.js";
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

describe("writeConfigFile canonical reread", () => {
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

  it("preserves committed source provenance when the post-write reread is invalid", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = {
        gateway: { mode: "local", port: 18789 },
        agents: { entries: { main: {} }, defaults: { compaction: {} } },
      };
      await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf-8");

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
        (target, options?: BufferEncoding | fsNode.ReadFileSyncOptions | null) => {
          if (corrupted && target === configPath) {
            return "{ definitely not json";
          }
          return realReadFileSync(
            target,
            typeof options === "string" ? { encoding: options } : (options ?? {}),
          );
        },
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const preflight = vi.fn<NonNullable<RuntimeConfigSnapshotRefreshHandler["preflight"]>>(
        ({ sourceConfig }) => ({ sourceConfig }),
      );
      const refresh = vi.fn<RuntimeConfigSnapshotRefreshHandler["refresh"]>(async () => true);
      setRuntimeConfigSnapshotRefreshHandler({ preflight, refresh });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
        async () => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
          setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
          await writeConfigFile({
            ...snapshot.config,
            gateway: { mode: "local", port: 19001 },
          });
        },
      );

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
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: () => undefined,
            refresh: () => {
              compensating = true;
              throw new Error("runtime activation refused");
            },
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
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            name: "ConfigWritePostCommitError",
            configPath,
            rollbackStatus: revoke ? "unknown" : "restored",
            message: expect.stringMatching(/runtime snapshot refresh failed/),
          });

          expect(committedRaw).toBeDefined();
          if (revoke) {
            expect(await fs.readFile(configPath, "utf8")).toBe(committedRaw);
            expect(JSON.parse(String(committedRaw)).gateway.port).toBe(19001);
          } else {
            expect(failure).not.toHaveProperty(
              "message",
              expect.stringContaining("Rollback failed"),
            );
            expect(await auditSnapshot()).toEqual(beforeAuditSnapshot);
            if (existed) {
              await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
            } else {
              await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
            }
          }
          expect(hash).toBe(
            hashConfigRaw(revoke ? String(committedRaw) : existed ? original : null),
          );
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
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: () => undefined,
            refresh: () => {
              throw new Error("runtime activation refused");
            },
          });
        }
        const write = async () => {
          const pending =
            writer === "direct"
              ? io.writeConfigFile(nextConfig, options)
              : writeConfigFile(nextConfig, options);
          const failure = await pending.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            name: "ConfigWritePostCommitError",
            configPath,
            rollbackStatus: "restored",
            message: expect.stringMatching(
              writer === "direct" ? /config path changed/ : /runtime snapshot refresh failed/,
            ),
          });
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
          const rootRenames: string[] = [];
          const mutations = (
            ["writeSync", "writeFileSync", "ftruncateSync", "rmSync"] as const
          ).map((name) => vi.spyOn(fsNode, name));
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
            rootRenames.length,
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
            rootRenames.push(String(source));
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
});
