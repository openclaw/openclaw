import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../infra/update-managed-service-handoff-database.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO, writeConfigFile } from "./io.js";
import {
  mutateConfigFile,
  mutateConfigFileWithRetry,
  replaceConfigFile,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "./mutate.js";
import { withConfigWriteLock } from "./write-lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withConfigExecutor(
  home: string,
  operation: (assertCurrent: () => void, revoke: () => void) => Promise<void>,
) {
  const root = path.join(await fs.realpath(home), "package");
  await fs.mkdir(root);
  const databasePath = path.join(home, "control", "managed-update-handoffs.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  await withUpdateCommandExecutor(
    "config-lock-fence",
    async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      await operation(fence.assertCurrent, () => releaseUpdateCommandPreflightForHandoff(fence));
    },
    {
      existingAuthority: {
        ...captureManagedUpdateLeaseDatabaseIdentity(databasePath),
        installKey: root,
      },
    },
  );
}

describe("direct config writer exclusion", () => {
  it.each(["replace", "snapshot", "mutate", "retry"] as const)(
    "rejects changed %s path provenance before creating the canonical lock directory",
    async (flow) => {
      const stateDir = tempDirs.make("openclaw-config-revoked-admission-");
      const configPath = path.join(stateDir, "source", "openclaw.json");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          const env = { ...process.env };
          const io = createConfigIO({ env, observe: false, pluginValidation: "skip" });
          const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
          env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "replacement.json");
          const options = {
            ...writeOptions,
            observe: false,
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
          };
          const nextConfig = { gateway: { mode: "local" as const, port: 19001 } };
          const mutation =
            flow === "replace" || flow === "snapshot"
              ? replaceConfigFile({
                  ...(flow === "snapshot" ? { snapshot } : {}),
                  writeOptions: options,
                  nextConfig,
                })
              : (flow === "retry" ? mutateConfigFileWithRetry : mutateConfigFile)({
                  writeOptions: options,
                  mutate: (draft) => {
                    draft.gateway = nextConfig.gateway;
                  },
                });

          await expect(mutation).rejects.toThrow("config path changed since last load");
          await expect(fs.stat(path.dirname(configPath))).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    },
  );

  it("retains the canonical source guard in a nested writer after a mutation retry", async () => {
    const stateDir = tempDirs.make("openclaw-config-retry-source-guard-");
    const configPath = path.join(stateDir, "openclaw.json");
    const concurrentRaw = '{"gateway":{"mode":"local","port":18999}}\n';
    await fs.writeFile(configPath, '{"gateway":{"mode":"local","port":18789}}\n');
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const env = { ...process.env };
        const io = createConfigIO({ env, observe: false, pluginValidation: "skip" });
        const { writeOptions } = await io.readConfigFileSnapshotForWrite();
        let attempts = 0;

        await withConfigExecutor(stateDir, async (assertCurrent, revoke) => {
          await expect(
            transformConfigFileWithRetry({
              maxAttempts: 2,
              writeOptions: {
                ...writeOptions,
                assertCurrent,
                observe: false,
                skipPluginValidation: true,
                skipRuntimeSnapshotRefresh: true,
              },
              transform: async (config, { attempt }) => {
                attempts += 1;
                if (attempt === 0) {
                  await fs.writeFile(configPath, concurrentRaw);
                } else {
                  await io.writeConfigFile(
                    { gateway: { mode: "local", port: 19003 } },
                    {
                      preCommitRuntimePreflight: async () => {
                        revoke();
                      },
                    },
                  );
                }
                return { nextConfig: { ...config, gateway: { mode: "local", port: 19001 } } };
              },
            }),
          ).rejects.toThrow(/executor ownership is no longer current|source ownership changed/);
        });

        expect(attempts).toBe(2);
        expect(await fs.readFile(configPath, "utf8")).toBe(concurrentRaw);
        await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it.each(["direct", "runtime"] as const)(
    "makes the %s writer wait for the canonical mutation scope",
    async (writerKind) => {
      const stateDir = tempDirs.make("openclaw-config-writer-exclusion-");
      const configPath = path.join(stateDir, "openclaw.json");
      const original = '{"gateway":{"mode":"local","port":18789}}\n';
      await fs.writeFile(configPath, original);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
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
              expect(await fs.readFile(configPath, "utf8")).toBe(original);
            });
          } finally {
            startWriter.resolve();
            await writer;
          }
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
        },
      );
    },
  );

  it("does not let detached work inherit a released mutation lock", async () => {
    const stateDir = tempDirs.make("openclaw-config-writer-detached-");
    const configPath = path.join(stateDir, "openclaw.json");
    const original = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, original);
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
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
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
          });
        } finally {
          startWriter.resolve();
          await writer;
        }
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      },
    );
  });

  it("keeps the lock until an already-admitted detached writer settles", async () => {
    const stateDir = tempDirs.make("openclaw-config-writer-inflight-");
    const configPath = path.join(stateDir, "openclaw.json");
    const original = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, original);
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
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
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          expect(await fs.stat(`${configPath}.lock`)).toBeDefined();
        } finally {
          finish.resolve();
          await owner;
          await writer;
        }
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      },
    );
  });

  it("closes guarded admission while an already-admitted writer drains", async () => {
    const stateDir = tempDirs.make("openclaw-config-closed-admission-");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, '{"gateway":{"mode":"local"}}\n');
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
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
      },
    );
  });

  it("allows a nested direct writer in the same live mutation scope", async () => {
    const stateDir = tempDirs.make("openclaw-config-writer-nested-");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, '{"gateway":{"mode":"local"}}\n');
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
        await withConfigMutationExclusive(async () => {
          await io.writeConfigFile({ gateway: { mode: "local", port: 19876 } });
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
        });
      },
    );
  });
});

describe("included config writer exclusion", () => {
  it.each([false, true])(
    "refuses inherited include authority before preparation (revoke=%s)",
    async (revoke) => {
      const stateDir = tempDirs.make("openclaw-include-source-guard-");
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "gateway.json5");
      const rootRaw = '{"gateway":{"$include":"./gateway.json5"}}\n';
      const includeRaw = '{"mode":"local","port":18789}\n';
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(includePath, includeRaw);
      const backupRaw = "retained include backup\n";
      await fs.writeFile(`${includePath}.bak`, backupRaw);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          const env = { ...process.env };
          const io = createConfigIO({ env, observe: false, pluginValidation: "skip" });
          const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
          const sourceConfig = structuredClone(snapshot.sourceConfig);
          sourceConfig.gateway = { ...sourceConfig.gateway, port: 19001 };
          let preflightReached = false;
          await withConfigExecutor(stateDir, async (assertCurrent, revokeExecutor) => {
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
                    observe: false,
                    skipPluginValidation: true,
                    skipRuntimeSnapshotRefresh: true,
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
            } else {
              await expect(mutation).rejects.toThrow(
                "cannot update include-owned configuration. Use a trusted shell",
              );
            }
            expect(preflightReached).toBe(false);
            expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
            expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
            expect(await fs.readFile(`${includePath}.bak`, "utf8")).toBe(backupRaw);
            await expect(fs.stat(`${includePath}.bak.1`)).rejects.toMatchObject({ code: "ENOENT" });
          });
        },
      );
    },
  );

  it.each(["top-level", "delegated"] as const)(
    "waits for exact included-file exclusion through a %s include",
    async (shape) => {
      const stateDir = tempDirs.make("openclaw-included-writer-exclusion-");
      const configPath = path.join(stateDir, "openclaw.json");
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
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(18789);
          const startWriter = deferred();
          const writer = startWriter.promise.then(() =>
            mutateConfigFileWithRetry({
              writeOptions: { skipPluginValidation: true, skipRuntimeSnapshotRefresh: true },
              mutate: (draft) => {
                draft.gateway = { ...draft.gateway, port: 19876 };
              },
            }),
          );
          try {
            await withConfigWriteLock(includePath, async () => {
              startWriter.resolve();
              expect(
                await Promise.race([writer.then(() => "wrote"), delay(250).then(() => "blocked")]),
              ).toBe("blocked");
              expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
              expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
            });
          } finally {
            startWriter.resolve();
            await writer;
          }
          expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
          if (shape === "delegated") {
            expect(await fs.readFile(parentPath, "utf8")).toBe(parentRaw);
          }
        },
      );
    },
  );
});
