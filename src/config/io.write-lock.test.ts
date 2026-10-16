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

const quietWrite = { observe: false, skipPluginValidation: true, skipRuntimeSnapshotRefresh: true };

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

describe("direct config writer exclusion", () => {
  it.each(["root", "include"] as const)(
    "rechecks requester admission after asynchronous preparation of a %s write",
    async (target) => {
      const { stateDir, configPath, run } = fixture("publication-admission");
      const includePath = path.join(stateDir, "gateway.json5");
      const gatewayRaw = '{"mode":"local","port":18789}\n';
      const rootRaw =
        target === "include"
          ? '{"gateway":{"$include":"./gateway.json5"}}\n'
          : `{"gateway":${gatewayRaw.trim()}}\n`;
      const writtenPath = target === "include" ? includePath : configPath;
      await fs.writeFile(configPath, rootRaw);
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
        await expectRaw(configPath, rootRaw);
        expect(await fs.readFile(writtenPath, "utf8")).toBe(
          target === "include" ? gatewayRaw : rootRaw,
        );
        await expectRaw(`${writtenPath}.bak`, "retained backup\n");
        await expect(fs.stat(`${writtenPath}.bak.1`)).rejects.toMatchObject({ code: "ENOENT" });
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
        const options = {
          ...writeOptions,
          ...quietWrite,
        };
        const nextConfig = { gateway: { mode: "local" as const, port: 19001 } };
        const mutation =
          flow === "snapshot"
            ? replaceConfigFile({
                snapshot,
                writeOptions: options,
                nextConfig,
              })
            : mutateConfigFileWithRetry({
                writeOptions: options,
                mutate: (draft) => {
                  draft.gateway = nextConfig.gateway;
                },
              });

        await expect(mutation).rejects.toThrow("config path changed since last load");
        await expect(fs.stat(path.dirname(configPath))).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("retains the canonical source guard in a nested writer after a mutation retry", async () => {
    const { stateDir, configPath, run } = fixture("retry-source-guard");
    const concurrentRaw = '{"gateway":{"mode":"local","port":18999}}\n';
    await fs.writeFile(configPath, '{"gateway":{"mode":"local","port":18789}}\n');
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
              writeOptions: {
                ...writeOptions,
                assertCurrent: sharedAuthority,
                ...quietWrite,
              },
              transform: async (config, { attempt }) => {
                attempts += 1;
                if (attempt === 0) {
                  await fs.writeFile(configPath, concurrentRaw);
                } else {
                  await replaceConfigFile({
                    io,
                    nextConfig: { gateway: { mode: "local", port: 19003 } },
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
                return { nextConfig: { ...config, gateway: { mode: "local", port: 19001 } } };
              },
            }),
          ).rejects.toThrow(/executor ownership is no longer current|source ownership changed/);
        });
      } finally {
        guardFactory.mockRestore();
      }

      expect(attempts).toBe(2);
      expect(sharedGuardCalls).toEqual([1, 2]);
      await expectRaw(configPath, concurrentRaw);
      await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["direct", "runtime"] as const)(
    "makes the %s writer wait for the canonical mutation scope",
    async (writerKind) => {
      const { configPath, run } = fixture("writer-exclusion");
      const original = '{"gateway":{"mode":"local","port":18789}}\n';
      await fs.writeFile(configPath, original);
      await run(async () => {
        const io = configIO(undefined, configPath);
        // Warm the existing dynamic writer import before scheduling the competing call.
        await import("./io.write.js");
        const startWriter = deferred();
        const writer = startWriter.promise.then(() =>
          writerKind === "direct"
            ? io.writeConfigFile({ gateway: { mode: "local", port: 19876 } })
            : writeConfigFile(
                { gateway: { mode: "local", port: 19876 } },
                {
                  skipPluginValidation: true,
                  skipRuntimeSnapshotRefresh: true,
                },
              ),
        );
        try {
          await withConfigMutationExclusive(async () => {
            startWriter.resolve();
            expect(
              await Promise.race([writer.then(() => "wrote"), delay(150).then(() => "blocked")]),
            ).toBe("blocked");
            await expectRaw(configPath, original);
          });
        } finally {
          startWriter.resolve();
          await writer;
        }
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      });
    },
  );

  it("does not let detached work inherit a released mutation lock", async () => {
    const { configPath, run } = fixture("writer-detached");
    const original = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, original);
    await run(async () => {
      const io = configIO(undefined, configPath);
      const startWriter = deferred();
      let writer!: Promise<unknown>;
      await withConfigMutationExclusive(async () => {
        writer = startWriter.promise.then(() =>
          io.writeConfigFile({ gateway: { mode: "local", port: 19876 } }),
        );
      });
      try {
        await withConfigMutationExclusive(async () => {
          startWriter.resolve();
          expect(
            await Promise.race([writer.then(() => "wrote"), delay(150).then(() => "blocked")]),
          ).toBe("blocked");
          await expectRaw(configPath, original);
        });
      } finally {
        startWriter.resolve();
        await writer;
      }
      expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
    });
  });

  it("keeps the lock until an already-admitted detached writer settles", async () => {
    const { configPath, run } = fixture("writer-inflight");
    const original = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, original);
    await run(async () => {
      const io = configIO(undefined, configPath);
      const entered = deferred();
      const finish = deferred();
      let writer!: Promise<unknown>;
      const owner = withConfigMutationExclusive(async () => {
        writer = io.writeConfigFile(
          { gateway: { mode: "local", port: 19876 } },
          {
            beforeCommit: async () => {
              entered.resolve();
              await finish.promise;
            },
          },
        );
        await entered.promise;
      });
      try {
        await entered.promise;
        expect(
          await Promise.race([owner.then(() => "released"), delay(150).then(() => "held")]),
        ).toBe("held");
        await expectRaw(configPath, original);
        expect(await fs.stat(`${configPath}.lock`)).toBeDefined();
      } finally {
        finish.resolve();
        await owner;
        await writer;
      }
      expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
    });
  });

  it("closes guarded admission while an already-admitted writer drains", async () => {
    const { configPath, run } = fixture("closed-admission");
    await fs.writeFile(configPath, '{"gateway":{"mode":"local"}}\n');
    await run(async () => {
      const io = configIO(undefined, configPath);
      const entered = deferred();
      const returned = deferred();
      const finish = deferred();
      let inherited: AsyncResource | undefined;
      let writer: Promise<unknown> | undefined;
      const owner = withConfigWriteLock(
        configPath,
        async () => {
          inherited = new AsyncResource("closed-config-owner");
          writer = io.writeConfigFile(
            { gateway: { mode: "local", port: 19876 } },
            {
              beforeCommit: async () => {
                entered.resolve();
                await finish.promise;
              },
            },
          );
          await entered.promise;
          returned.resolve();
        },
        undefined,
        () => undefined,
      );
      try {
        await returned.promise;
        // Yield the outer callback's settlement, but leave the admitted writer blocked.
        await delay(0);
        const late = inherited!.runInAsyncScope(() =>
          io.writeConfigFile({ gateway: { mode: "local", port: 19877 } }),
        );
        await expect(late).rejects.toThrow(/admission has closed/);
        expect(await fs.stat(`${configPath}.lock`)).toBeDefined();
      } finally {
        finish.resolve();
        await owner;
        await writer;
        inherited?.emitDestroy();
      }
      expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
    });
  });
});

describe("included config writer exclusion", () => {
  it.each([false, true])(
    "retains original executor ownership for inherited include writes (revoke=%s)",
    async (revoke) => {
      const { stateDir, configPath, run } = fixture("include-source-guard");
      const includePath = path.join(stateDir, "gateway.json5");
      const rootRaw = '{"gateway":{"$include":"./gateway.json5"}}\n';
      const includeRaw = '{"mode":"local","port":18789}\n';
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(includePath, includeRaw);
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
            await expect(mutation).rejects.toThrow(
              /executor ownership is no longer current|source ownership changed/,
            );
            expect(preflightReached).toBe(false);
            await expectRaw(includePath, includeRaw);
            await expectRaw(`${includePath}.bak`, backupRaw);
            await expect(fs.stat(`${includePath}.bak.1`)).rejects.toMatchObject({
              code: "ENOENT",
            });
          } else {
            await expect(mutation).resolves.toMatchObject({
              persistedSourceConfig: { gateway: { mode: "local", port: 19001 } },
            });
            expect(preflightReached).toBe(true);
            expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({
              mode: "local",
              port: 19001,
            });
            await expectRaw(`${includePath}.bak`, includeRaw);
            await expectRaw(`${includePath}.bak.1`, backupRaw);
          }
          await expectRaw(configPath, rootRaw);
        });
      });
    },
  );

  it.each(["top-level", "delegated"] as const)(
    "waits for exact included-file exclusion through a %s include",
    async (shape) => {
      const { stateDir, configPath, run } = fixture("included-writer-exclusion");
      const includePath = path.join(stateDir, "gateway.json5");
      const rootRaw =
        shape === "delegated"
          ? '{"gateway":{"$include":"./gateway-parent.json5"}}\n'
          : '{"gateway":{"$include":"./gateway.json5"}}\n';
      const includeRaw = '{"mode":"local","port":18789}\n';
      const parentPath = path.join(stateDir, "gateway-parent.json5");
      const parentRaw = '{"$include":"./gateway.json5"}\n';
      if (shape === "delegated") {
        await fs.writeFile(parentPath, parentRaw);
      }
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(includePath, includeRaw);
      await run(async () => {
        const io = configIO(undefined, configPath);
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(18789);
        const startWriter = deferred();
        const writer = startWriter.promise.then(() =>
          mutateConfigFileWithRetry({
            writeOptions: { skipPluginValidation: true, skipRuntimeSnapshotRefresh: true },
            mutate: (draft, { snapshot }) => {
              draft.gateway = { ...draft.gateway, port: 19876 };
              const boundary = resolveConfigIncludeWriteBoundary({ snapshot, nextConfig: draft });
              expect(snapshot.valid).toBe(true);
              expect(snapshot.issues).toEqual([]);
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
        try {
          await withConfigWriteLock(includePath, async () => {
            startWriter.resolve();
            expect(
              await Promise.race([writer.then(() => "wrote"), delay(250).then(() => "blocked")]),
            ).toBe("blocked");
            await expectRaw(configPath, rootRaw);
            await expectRaw(includePath, includeRaw);
          });
        } finally {
          startWriter.resolve();
          await writer;
        }
        await expectRaw(configPath, rootRaw);
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
        if (shape === "delegated") {
          await expectRaw(parentPath, parentRaw);
        }
      });
    },
  );
});
