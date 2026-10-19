import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withExecutor } from "./config-executor.test-support.js";
import { createConfigIO, writeConfigFile } from "./io.js";
import * as configWriteSafety from "./io.write-safety.js";
import {
  mutateConfigFileWithRetry,
  replaceConfigFile,
  resolveConfigIncludeWriteBoundary,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "./mutate.js";
import { composeConfigWriteAssertions } from "./write-authority.js";
import { withConfigWriteLock } from "./write-lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

const runtimeWrite = { skipPluginValidation: true, skipRuntimeSnapshotRefresh: true };
const quietWrite = { observe: false, ...runtimeWrite };
const gateway = (port = 19876) => ({ gateway: { mode: "local" as const, port } });
const gatewayRaw = '{"mode":"local","port":18789}\n';
const rootRaw = `{"gateway":${gatewayRaw.trim()}}\n`;
const includedRoot = '{"gateway":{"$include":"./gateway.json5"}}\n';
const ownershipError = /executor ownership is no longer current|source ownership changed/;

function fixture(name: string, file = "openclaw.json") {
  const stateDir = tempDirs.make(`openclaw-config-${name}-`);
  const configPath = path.join(stateDir, file);
  return {
    stateDir,
    configPath,
    run: <T>(callback: () => Promise<T>) =>
      withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath }, callback),
  };
}

function configIO(env?: NodeJS.ProcessEnv, configPath?: string) {
  return createConfigIO({ env, configPath, observe: false, pluginValidation: "skip" });
}

async function expectRaw(file: string, raw: string) {
  expect(await fs.readFile(file, "utf8")).toBe(raw);
}

async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectBlocked(pending: Promise<unknown>, ms = 150) {
  expect(await Promise.race([pending.then(() => "settled"), delay(ms).then(() => "blocked")])).toBe(
    "blocked",
  );
}

async function releaseWriterAfter(
  start: ReturnType<typeof deferred<void>>,
  writer: Promise<unknown>,
  scope: (check: () => Promise<void>) => Promise<unknown>,
  check: () => Promise<void>,
  ms = 150,
) {
  try {
    await scope(async () => {
      start.resolve();
      await expectBlocked(writer, ms);
      await check();
    });
  } finally {
    start.resolve();
    await writer;
  }
}

describe("direct config writer exclusion", () => {
  it.each(["root", "include"] as const)(
    "rechecks requester admission after asynchronous preparation of a %s write",
    async (target) => {
      const { stateDir, configPath, run } = fixture("publication-admission");
      const includePath = path.join(stateDir, "gateway.json5");
      const original = target === "include" ? includedRoot : rootRaw;
      const writtenPath = target === "include" ? includePath : configPath;
      await fs.writeFile(configPath, original);
      if (target === "include") {
        await fs.writeFile(includePath, gatewayRaw);
      }
      await fs.writeFile(`${writtenPath}.bak`, "retained backup\n");
      await run(async () => {
        const io = configIO();
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
        const sourceConfig = structuredClone(snapshot.sourceConfig);
        sourceConfig.gateway = { ...sourceConfig.gateway, port: 19001 };
        let current = true;
        const assertBeforePublish = vi.fn(() => {
          if (!current) {
            throw new Error("requester revoked before publication");
          }
        });
        await expect(
          replaceConfigFile({
            snapshot,
            sourceConfig,
            writeOptions: {
              ...writeOptions,
              ...quietWrite,
              beforeCommit: async () => {
                await Promise.resolve();
                current = false;
              },
              assertBeforePublish,
            },
          }),
        ).rejects.toThrow("requester revoked before publication");
        expect(assertBeforePublish).toHaveBeenCalledOnce();
        await expectRaw(configPath, original);
        await expectRaw(writtenPath, target === "include" ? gatewayRaw : original);
        await expectRaw(`${writtenPath}.bak`, "retained backup\n");
        await expectMissing(`${writtenPath}.bak.1`);
      });
    },
  );

  it.each(["snapshot", "retry"] as const)(
    "rejects changed %s path provenance before creating the canonical lock directory",
    async (flow) => {
      const { stateDir, configPath, run } = fixture("revoked-admission", "source/openclaw.json");
      await run(async () => {
        const env = { ...process.env };
        const io = configIO(env);
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
        env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "replacement.json");
        const options = { ...writeOptions, ...quietWrite };
        const nextConfig = gateway(19001);
        const mutation =
          flow === "snapshot"
            ? replaceConfigFile({ snapshot, writeOptions: options, nextConfig })
            : mutateConfigFileWithRetry({
                writeOptions: options,
                mutate: (draft) => {
                  draft.gateway = nextConfig.gateway;
                },
              });

        await expect(mutation).rejects.toThrow("config path changed since last load");
        await expectMissing(path.dirname(configPath));
      });
    },
  );

  it("retains the canonical source guard in a nested writer after a mutation retry", async () => {
    const { stateDir, configPath, run } = fixture("retry-source-guard");
    const concurrentRaw = '{"gateway":{"mode":"local","port":18999}}\n';
    await fs.writeFile(configPath, rootRaw);
    await run(async () => {
      const env = { ...process.env };
      const io = configIO(env);
      const { writeOptions } = await io.readConfigFileSnapshotForWrite();
      let attempts = 0;
      const sharedGuardCalls: number[] = [];
      const guardFactory = vi.spyOn(configWriteSafety, "createConfigFileWriteGuard");

      try {
        await withExecutor(stateDir, "config-lock-fence", async (assertCurrent, revoke) => {
          const sharedAuthority = vi.fn(assertCurrent);
          await expect(
            transformConfigFileWithRetry({
              maxAttempts: 2,
              writeOptions: { ...writeOptions, assertCurrent: sharedAuthority, ...quietWrite },
              transform: async (config, { attempt }) => {
                attempts += 1;
                if (attempt === 0) {
                  await fs.writeFile(configPath, concurrentRaw);
                } else {
                  await replaceConfigFile({
                    io,
                    nextConfig: gateway(19003),
                    writeOptions: {
                      ...writeOptions,
                      assertConfigPathForWrite: composeConfigWriteAssertions(
                        writeOptions.assertConfigPathForWrite,
                        sharedAuthority,
                      ),
                      beforeCommit: async () => {
                        const publicationGuard = guardFactory.mock.lastCall?.[2];
                        if (!publicationGuard) {
                          throw new Error("Missing config publication guard");
                        }
                        sharedAuthority.mockClear();
                        publicationGuard();
                        sharedGuardCalls.push(sharedAuthority.mock.calls.length);
                        await Promise.resolve();
                        publicationGuard();
                        sharedGuardCalls.push(sharedAuthority.mock.calls.length);
                        revoke();
                      },
                    },
                  });
                }
                return { nextConfig: { ...config, ...gateway(19001) } };
              },
            }),
          ).rejects.toThrow(ownershipError);
        });
      } finally {
        guardFactory.mockRestore();
      }

      expect(attempts).toBe(2);
      expect(sharedGuardCalls).toEqual([1, 2]);
      await expectRaw(configPath, concurrentRaw);
      await expectMissing(`${configPath}.bak`);
    });
  });

  it.each(["direct", "runtime", "detached"] as const)(
    "makes the %s writer wait for the canonical mutation scope",
    async (writerKind) => {
      const { configPath, run } = fixture("writer-exclusion");
      await fs.writeFile(configPath, rootRaw);
      await run(async () => {
        const io = configIO(undefined, configPath);
        // Warm the existing dynamic writer import before scheduling the competing call.
        await import("./io.write.js");
        const startWriter = deferred();
        const schedule = () =>
          startWriter.promise.then(() =>
            writerKind === "runtime"
              ? writeConfigFile(gateway(), runtimeWrite)
              : io.writeConfigFile(gateway()),
          );
        let writer!: Promise<unknown>;
        if (writerKind === "detached") {
          await withConfigMutationExclusive(async () => {
            writer = schedule();
          });
        } else {
          writer = schedule();
        }
        await releaseWriterAfter(startWriter, writer, withConfigMutationExclusive, () =>
          expectRaw(configPath, rootRaw),
        );
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      });
    },
  );

  it.each([false, true])(
    "drains admitted writers with closed guarded admission=%s",
    async (guarded) => {
      const { configPath, run } = fixture("writer-inflight");
      const original = '{"gateway":{"mode":"local"}}\n';
      await fs.writeFile(configPath, original);
      await run(async () => {
        const io = configIO(undefined, configPath);
        const entered = deferred();
        const finish = deferred();
        const returned = deferred();
        let inherited: AsyncResource | undefined;
        let writer!: Promise<unknown>;
        const callback = async () => {
          if (guarded) {
            inherited = new AsyncResource("closed-config-owner");
          }
          writer = io.writeConfigFile(gateway(), {
            beforeCommit: async () => {
              entered.resolve();
              await finish.promise;
            },
          });
          await entered.promise;
          returned.resolve();
        };
        const owner = guarded
          ? withConfigWriteLock(configPath, callback, undefined, () => undefined)
          : withConfigMutationExclusive(callback);
        try {
          await returned.promise;
          if (guarded) {
            await delay(0);
          } else {
            await expectBlocked(owner);
          }
          await expectRaw(configPath, original);
          if (guarded) {
            const late = inherited!.runInAsyncScope(() => io.writeConfigFile(gateway(19877)));
            await expect(late).rejects.toThrow(/admission has closed/);
          }
          expect(await fs.stat(`${configPath}.lock`)).toBeDefined();
        } finally {
          finish.resolve();
          await owner;
          await writer;
          inherited?.emitDestroy();
        }
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      });
    },
  );
});

describe("included config writer exclusion", () => {
  it.each([false, true])(
    "retains original executor ownership for inherited include writes (revoke=%s)",
    async (revoke) => {
      const { stateDir, configPath, run } = fixture("include-source-guard");
      const includePath = path.join(stateDir, "gateway.json5");
      await fs.writeFile(configPath, includedRoot);
      await fs.writeFile(includePath, gatewayRaw);
      const backupRaw = "retained include backup\n";
      await fs.writeFile(`${includePath}.bak`, backupRaw);
      await run(async () => {
        const env = { ...process.env };
        const io = configIO(env);
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
        const sourceConfig = structuredClone(snapshot.sourceConfig);
        sourceConfig.gateway = { ...sourceConfig.gateway, port: 19001 };
        let preflightReached = false;
        await withExecutor(stateDir, "config-lock-fence", async (assertCurrent, revokeExecutor) => {
          const mutation = withConfigWriteLock(
            configPath,
            () => {
              if (revoke) {
                revokeExecutor();
              }
              return replaceConfigFile({
                snapshot,
                sourceConfig,
                writeOptions: {
                  ...writeOptions,
                  ...quietWrite,
                  preCommitRuntimePreflight: async () => {
                    preflightReached = true;
                  },
                },
              });
            },
            env,
            assertCurrent,
          );
          if (revoke) {
            await expect(mutation).rejects.toThrow(ownershipError);
            expect(preflightReached).toBe(false);
            await expectRaw(includePath, gatewayRaw);
            await expectRaw(`${includePath}.bak`, backupRaw);
            await expectMissing(`${includePath}.bak.1`);
          } else {
            await expect(mutation).resolves.toMatchObject({
              persistedSourceConfig: gateway(19001),
            });
            expect(preflightReached).toBe(true);
            expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({
              mode: "local",
              port: 19001,
            });
            await expectRaw(`${includePath}.bak`, gatewayRaw);
            await expectRaw(`${includePath}.bak.1`, backupRaw);
          }
          await expectRaw(configPath, includedRoot);
        });
      });
    },
  );
  it.each(["top-level", "delegated"] as const)(
    "waits for exact included-file exclusion through a %s include",
    async (shape) => {
      const { stateDir, configPath, run } = fixture("included-writer-exclusion");
      const includePath = path.join(stateDir, "gateway.json5");
      const original =
        shape === "delegated"
          ? '{"gateway":{"$include":"./gateway-parent.json5"}}\n'
          : includedRoot;
      const parentPath = path.join(stateDir, "gateway-parent.json5");
      const parentRaw = '{"$include":"./gateway.json5"}\n';
      if (shape === "delegated") {
        await fs.writeFile(parentPath, parentRaw);
      }
      await fs.writeFile(configPath, original);
      await fs.writeFile(includePath, gatewayRaw);
      await run(async () => {
        const io = configIO(undefined, configPath);
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(18789);
        const startWriter = deferred();
        const writer = startWriter.promise.then(() =>
          mutateConfigFileWithRetry({
            writeOptions: runtimeWrite,
            mutate: (draft, { snapshot }) => {
              draft.gateway = { ...draft.gateway, port: 19876 };
              const boundary = resolveConfigIncludeWriteBoundary({ snapshot, nextConfig: draft });
              expect(snapshot).toMatchObject({ valid: true, issues: [] });
              expect(snapshot.includeProvenance).toEqual(
                (shape === "delegated" ? [includePath, parentPath] : [includePath]).map(
                  (targetPath) =>
                    expect.objectContaining({
                      path: ["gateway"],
                      targetPath,
                      kind: "single",
                      hasSiblingOverrides: false,
                    }),
                ),
              );
              expect(snapshot.includeProvenance?.some((entry) => entry.hasArrayAncestor)).toBe(
                false,
              );
              expect(boundary).toMatchObject({ boundaryPath: ["gateway"], includePath });
            },
          }),
        );
        await releaseWriterAfter(
          startWriter,
          writer,
          (check) => withConfigWriteLock(includePath, check),
          async () => {
            await expectRaw(configPath, original);
            await expectRaw(includePath, gatewayRaw);
          },
          250,
        );
        await expectRaw(configPath, original);
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
        if (shape === "delegated") {
          await expectRaw(parentPath, parentRaw);
        }
      });
    },
  );
});
