import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withExecutor } from "./config-executor.test-support.js";
import { createConfigIO, writeConfigFile } from "./io.js";
import {
  mutateConfigFileWithRetry,
  replaceConfigFile,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "./mutate.js";
import { composeConfigWriteAssertions } from "./write-authority.js";
import { withConfigWriteLock } from "./write-lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.unstubAllEnvs();
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

async function fixture(
  name: string,
  { include = false, missing = false, raw = rootRaw, backup = false } = {},
) {
  const stateDir = tempDirs.make(`openclaw-config-${name}-`);
  const configPath = path.join(stateDir, missing ? "source/openclaw.json" : "openclaw.json");
  const includePath = path.join(stateDir, "gateway.json5");
  const writtenPath = include ? includePath : configPath;
  if (!missing) {
    await fs.writeFile(configPath, include ? includedRoot : raw);
    if (include) {
      await fs.writeFile(includePath, gatewayRaw);
    }
    if (backup) {
      await fs.writeFile(`${writtenPath}.bak`, "retained backup\n");
    }
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const env = { ...process.env };
  const io = createConfigIO({ env, observe: false, pluginValidation: "skip" });
  return { stateDir, configPath, includePath, writtenPath, env, io };
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

it.each(["root", "include"] as const)(
  "rechecks requester admission after asynchronous preparation of a %s write",
  async (target) => {
    const original = target === "include" ? includedRoot : rootRaw;
    const { io, configPath, writtenPath } = await fixture("publication-admission", {
      include: target === "include",
      backup: true,
    });
    const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
    let current = true;
    const assertBeforePublish = () => {
      if (!current) {
        throw new Error("requester revoked before publication");
      }
    };
    await expect(
      replaceConfigFile({
        snapshot,
        sourceConfig: { ...snapshot.sourceConfig, ...gateway(19001) },
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
    await expectRaw(configPath, original);
    await expectRaw(writtenPath, target === "include" ? gatewayRaw : original);
    await expectRaw(`${writtenPath}.bak`, "retained backup\n");
    await expectMissing(`${writtenPath}.bak.1`);
  },
);

it.each(["snapshot", "retry"] as const)(
  "rejects changed %s path provenance before creating the canonical lock directory",
  async (flow) => {
    const { stateDir, configPath, env, io } = await fixture("revoked-admission", { missing: true });
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
  },
);

it("retains the canonical source guard in a nested writer after a mutation retry", async () => {
  const concurrentRaw = '{"gateway":{"mode":"local","port":18999}}\n';
  const { stateDir, configPath, io } = await fixture("retry-source-guard");
  const { writeOptions } = await io.readConfigFileSnapshotForWrite();
  await withExecutor(stateDir, "config-lock-fence", async (assertCurrent, revoke) => {
    await expect(
      transformConfigFileWithRetry({
        maxAttempts: 2,
        writeOptions: { ...writeOptions, assertCurrent, ...quietWrite },
        transform: async (config, { attempt }) => {
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
                  assertCurrent,
                ),
                beforeCommit: async () => {
                  await Promise.resolve();
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
  await expectRaw(configPath, concurrentRaw);
  await expectMissing(`${configPath}.bak`);
});

it.each(["direct", "runtime", "detached"] as const)(
  "makes the %s writer wait for the canonical mutation scope",
  async (writerKind) => {
    const { configPath, io } = await fixture("writer-exclusion");
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
  },
);

it.each([false, true])(
  "drains admitted writers with closed guarded admission=%s",
  async (guarded) => {
    const original = '{"gateway":{"mode":"local"}}\n';
    const { configPath, io } = await fixture("writer-inflight", { raw: original });
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
  },
);
it.each([false, true])(
  "retains original executor ownership for inherited include writes (revoke=%s)",
  async (revoke) => {
    const { stateDir, configPath, includePath, env, io } = await fixture("include-source-guard", {
      include: true,
      backup: true,
    });
    const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
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
            sourceConfig: { ...snapshot.sourceConfig, ...gateway(19001) },
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
        await expectRaw(`${includePath}.bak`, "retained backup\n");
        await expectMissing(`${includePath}.bak.1`);
      } else {
        await expect(mutation).resolves.toMatchObject({
          persistedSourceConfig: gateway(19001),
        });
        expect(preflightReached).toBe(true);
        expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual(gateway(19001).gateway);
        await expectRaw(`${includePath}.bak`, gatewayRaw);
        await expectRaw(`${includePath}.bak.1`, "retained backup\n");
      }
      await expectRaw(configPath, includedRoot);
    });
  },
);
it.each(["top-level", "delegated"] as const)(
  "waits for exact included-file exclusion through a %s include",
  async (shape) => {
    const original =
      shape === "delegated" ? '{"gateway":{"$include":"./gateway-parent.json5"}}\n' : includedRoot;
    const parentRaw = '{"$include":"./gateway.json5"}\n';
    const { stateDir, configPath, includePath, io } = await fixture("included-writer-exclusion", {
      include: true,
    });
    const parentPath = path.join(stateDir, "gateway-parent.json5");
    if (shape === "delegated") {
      await fs.writeFile(configPath, original);
      await fs.writeFile(parentPath, parentRaw);
    }
    expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(18789);
    const startWriter = deferred();
    const writer = startWriter.promise.then(() =>
      mutateConfigFileWithRetry({
        writeOptions: runtimeWrite,
        mutate: (draft) => {
          draft.gateway = { ...draft.gateway, port: 19876 };
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
  },
);
