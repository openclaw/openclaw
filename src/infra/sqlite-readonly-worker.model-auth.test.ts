import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath } from "../agents/auth-profiles/mutation-lineage.js";
import { overlayRuntimeExternalOAuthProfiles } from "../agents/auth-profiles/oauth-shared.js";
import * as authPathResolve from "../agents/auth-profiles/path-resolve.js";
import { markAuthProfileSuccess } from "../agents/auth-profiles/profiles.js";
import {
  getRuntimeAuthProfileStoreMetadataRevision,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../agents/auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreForRuntimeAsync,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles/store-runtime.js";
import { withAuthProfileStoreAgentDir } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../agents/embedded-agent-runner/model.js";
import type { ProviderRuntimeHooks } from "../agents/embedded-agent-runner/model.provider-hooks.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createSqliteWorkerBackend } from "../state/openclaw-state.worker.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import * as sqliteWorker from "./sqlite-readonly-worker.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "./sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const PROVIDER = "auth-runtime-fixture";
const PROFILE_ID = `${PROVIDER}:default`;
const MODEL_ID = "fixture-model";

function fixtureStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: { [PROFILE_ID]: { type: "api_key", provider: PROVIDER, key } },
  };
}

function personalAccountFixture() {
  const key = randomUUID();
  const owner = ensureProfileForEmail(`personal-${key}@example.test`);
  const credential = { type: "api_key" as const, provider: PROVIDER, key };
  const { authProfileId } = connectUserModelAccount({
    ownerProfileId: owner.id,
    credential,
    assertCurrent: () => {},
  });
  return { authProfileId, credential };
}

function modelResolver(state: OpenClawTestState, options?: { automatic: boolean }) {
  const stores = createEmptyAgentDiscoveryStores();
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: PROVIDER, providers: [PROVIDER] }],
  });
  const hooks: ProviderRuntimeHooks = {
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    prepareProviderDynamicModel: async () => undefined,
    runProviderDynamicModel: ({ context }) =>
      makeProviderModelFixture({
        id: MODEL_ID,
        provider: PROVIDER,
        api: "openai-completions",
        baseUrl: "https://auth-runtime.example.invalid/v1",
        name: `${context.authProfileId}:${context.authProfileMode}`,
      }),
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
  };
  return (authProfileId = options?.automatic ? undefined : PROFILE_ID) =>
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      resolveModelAsync(
        PROVIDER,
        MODEL_ID,
        state.agentDir(),
        {},
        {
          ...stores,
          authProfileId,
          runtimeHooks: hooks,
          skipAgentDiscovery: true,
          workspaceDir: state.workspaceDir,
        },
      ),
    );
}

describe("model resolution auth row snapshots", () => {
  it("loads the selected personal account through the real worker and redacts its host result", async () => {
    await withOpenClawTestState({ label: "model-auth-personal-worker" }, async (state) => {
      await state.writeAuthProfiles(fixtureStore("fixture-shared"));
      const { authProfileId, credential } = personalAccountFixture();
      const redact = () => redactRegisteredSecretValues(credential.key, () => "[redacted]");
      expect(redact()).toBe(credential.key);

      const store = await loadAuthProfileStoreForRuntimeAsync(state.agentDir(), {
        profileId: authProfileId,
        inheritedAuthDir: state.agentDir(),
        readOnly: true,
        allowKeychainPrompt: false,
        externalCli: { mode: "none" },
      });

      expect(store.profiles[authProfileId]).toMatchObject(credential);
      expect(store.profiles[PROFILE_ID]).toMatchObject({ key: "fixture-shared" });
      expect(redact()).toBe("[redacted]");
    });
  });

  it("drains an admitted personal read before closing its maintenance owner and rejects reuse", async () => {
    await withOpenClawTestState({ label: "model-auth-personal-maintenance" }, async () => {
      const { authProfileId, credential } = personalAccountFixture();
      const scope = createOpenClawDatabaseMaintenanceScope();
      const context = scope.run(() => captureOpenClawStateWorkerContext());
      const loading = scope.run(() =>
        sqliteRead.readUserModelAuthProfileAsync(authProfileId, context),
      );
      const closing = scope.close();
      try {
        await expect(loading).resolves.toMatchObject({ credential });
        await closing;
        await expect(
          sqliteRead.readUserModelAuthProfileAsync(authProfileId, context),
        ).rejects.toThrow(/scope is closed|admission is closed/);
      } finally {
        await Promise.allSettled([loading, closing]);
        await scope.close();
      }
    });
  });

  it.each(["row", "cache proof"])("evicts a shared handle after %s corruption", async (stage) => {
    await withOpenClawTestState({ label: "model-auth-query-corruption" }, async (state) => {
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        profiles: [
          {
            profileId: PROFILE_ID,
            credential: fixtureStore("fixture-original").profiles[PROFILE_ID]!,
          },
        ],
      });
      const context = captureOpenClawStateWorkerContext();
      const database = openOpenClawStateDatabase({ path: context.admission.databasePath });
      const backend = runWithSqliteWorkerStateContext(context, () =>
        createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
      );
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      const prepare = database.db.prepare.bind(database.db);
      let injected = false;
      const fault = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
        if (
          sql ===
          (stage === "row"
            ? "SELECT type FROM sqlite_master WHERE name = ?"
            : "PRAGMA main.wal_checkpoint(NOOP)")
        ) {
          injected = true;
          throw Object.assign(new Error("database disk image is malformed"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 11,
          });
        }
        return prepare(sql);
      });
      try {
        await runWithSqliteWorkerStateContext(context, () =>
          backend[SQLITE_WORKER_PREPARE_COMMAND]?.("authProfiles.read"),
        );
        const rows = await runWithSqliteWorkerStateContext(context, () =>
          backend.execute({ type: "authProfiles.read", input: { artifactPreserving: false } }),
        );
        expect(injected).toBe(true);
        expect(rows).toMatchObject({ store: { status: "unreadable" }, cacheable: false });
        expect(
          openClawStateDatabaseCache.getCachedOpenClawStateDatabase(database.path) === database,
        ).toBe(false);
      } finally {
        fault.mockRestore();
        await backend.close();
      }
    });
  });

  it.each([false, true])(
    "does not retain rows before WAL commit publication (shared=%s)",
    async (shared) => {
      let sharedMemory: number | undefined;
      try {
        await withOpenClawTestState({ label: "model-auth-wal-publication" }, async (state) => {
          const store = fixtureStore("fixture-original");
          if (shared) {
            await persistAuthProfileBatch({
              stateDir: state.stateDir,
              profiles: [{ profileId: PROFILE_ID, credential: store.profiles[PROFILE_ID]! }],
            });
          } else {
            await state.writeAuthProfiles(store);
          }
          const agentDir = shared ? undefined : state.agentDir();
          const databasePath = shared
            ? authPathResolve.resolveSharedAuthStorePath()
            : resolveAuthProfileDatabasePath(state.agentDir());
          sharedMemory = fs.openSync(`${databasePath}-shm`, "r+");
          const readHeader = () => {
            const header = Buffer.alloc(96);
            expect(fs.readSync(sharedMemory!, header, 0, header.length, 0)).toBe(header.length);
            return header;
          };
          const previousHeader = readHeader();
          const rotated: AuthProfileStore = {
            version: 1,
            profiles: {
              [PROFILE_ID]: { type: "token", provider: PROVIDER, token: "fixture-published" },
            },
          };
          writePersistedAuthProfileStoreRaw(rotated, agentDir);
          const committedHeader = readHeader();
          expect(committedHeader).not.toEqual(previousHeader);
          const walStamp = () => {
            const stat = fs.statSync(`${databasePath}-wal`, { bigint: true });
            return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
          };
          const writtenWal = walStamp();
          // Hold the valid old WAL-index header over completed frame I/O, then publish it.
          fs.writeSync(sharedMemory, previousHeader, 0, previousHeader.length, 0);
          try {
            const resolve = modelResolver(state);
            expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
            fs.writeSync(sharedMemory, committedHeader, 0, committedHeader.length, 0);
            expect(walStamp()).toEqual(writtenWal);
            expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:token`);
          } finally {
            fs.writeSync(sharedMemory, committedHeader, 0, committedHeader.length, 0);
          }
        });
      } finally {
        // Closing an SHM descriptor must wait until the fixture closes its SQLite handles.
        if (sharedMemory !== undefined) {
          fs.closeSync(sharedMemory);
        }
      }
    },
  );

  it.each([
    { change: "usage", cached: false, published: false },
    { change: "usage", cached: true, published: false },
    { change: "usage", cached: false, published: true },
    { change: "usage", cached: true, published: true },
    { change: "usage", cached: false, published: "during" },
    { change: "usage", cached: true, published: "during" },
    { change: "order", cached: true, published: false },
    { change: "disabled", cached: false, published: false },
    { change: "order", cached: true, published: "during" },
    { change: "disabled", cached: false, published: "during" },
    { change: "unrelated-order", cached: true, published: false },
  ] as const)(
    "handles concurrent $change changes (cached=$cached, published=$published)",
    async ({ change, cached, published }) => {
      await withOpenClawTestState({ label: "model-auth-concurrent-usage" }, async (state) => {
        const store = fixtureStore("fixture-original");
        const fallbackProfileId = `${PROVIDER}:fallback`;
        store.profiles[fallbackProfileId] = {
          type: "token",
          provider: PROVIDER,
          token: "fixture-fallback",
        };
        store.order = { [PROVIDER]: [PROFILE_ID, fallbackProfileId] };
        await state.writeAuthProfiles(store);
        if (change === "unrelated-order") {
          await state.writeAuthProfiles(store, "other");
        }
        if (published === true) {
          setRuntimeAuthProfileStoreSnapshot(store, state.agentDir());
        }
        const resolve = modelResolver(state, { automatic: true });
        if (cached) {
          expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        }
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const prepare = sqliteRead.prepareAgentAuthProfileRowsRead;
        const sharedOwnership = authPathResolve.resolveSharedAuthStoreOwnershipAsync;
        const databasePath = resolveAuthProfileDatabasePath(state.agentDir());
        const pause = async <T>(value: Promise<T>): Promise<T> => {
          const result = await value;
          entered.resolve();
          await resume.promise;
          return result;
        };
        const read = cached
          ? vi
              .spyOn(authPathResolve, "resolveSharedAuthStoreOwnershipAsync")
              .mockImplementation((context) => pause(sharedOwnership(context)))
          : vi
              .spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead")
              .mockImplementation((options) => {
                const reader = prepare(options);
                return options.databasePath === databasePath
                  ? { ...reader, read: () => pause(reader.read()) }
                  : reader;
              });
        const loading = resolve();
        try {
          await Promise.race([
            entered.promise,
            loading.then(() => {
              throw new Error("Model resolution completed before the usage-write barrier");
            }),
          ]);
          if (published === "during") {
            setRuntimeAuthProfileStoreSnapshot(store, state.agentDir());
          }
          const updated: AuthProfileStore =
            change === "order" || change === "unrelated-order"
              ? { ...store, order: { [PROVIDER]: [fallbackProfileId, PROFILE_ID] } }
              : {
                  ...store,
                  usageStats: {
                    [PROFILE_ID]:
                      change === "disabled"
                        ? { disabledUntil: Date.now() + 60_000, disabledReason: "auth_permanent" }
                        : { lastUsed: 1234, lastProbeAt: 1234 },
                  },
                };
          const updatedAgent = change === "unrelated-order" ? "other" : "main";
          await state.writeAuthProfiles(updated, updatedAgent);
          resume.resolve();
          expect((await loading).model?.name).toBe(
            change === "order" || change === "disabled"
              ? `${fallbackProfileId}:token`
              : `${PROFILE_ID}:api_key`,
          );
          const current = await loadAuthProfileStoreForRuntimeAsync(state.agentDir(updatedAgent), {
            readOnly: true,
            externalCli: { mode: "none" },
          });
          expect(current).toMatchObject(updated);
        } finally {
          resume.resolve();
          await Promise.allSettled([loading]);
          read.mockRestore();
        }
      });
    },
  );

  it("preserves authoritative empty external auth during a successful inherited usage write", async () => {
    await withOpenClawTestState(
      { label: "model-auth-empty-external-publication" },
      async (state) => {
        const store = fixtureStore("fixture-original");
        await persistAuthProfileBatch({
          stateDir: state.stateDir,
          profiles: [{ profileId: PROFILE_ID, credential: store.profiles[PROFILE_ID]! }],
        });
        for (const agentDir of [undefined, state.agentDir()]) {
          setRuntimeAuthProfileStoreSnapshot(
            overlayRuntimeExternalOAuthProfiles(
              loadAuthProfileStoreWithoutExternalProfiles(agentDir),
              [],
              {
                runtimeExternalProfileIdsAuthoritative: true,
              },
            ),
            agentDir,
          );
        }
        const before = getRuntimeAuthProfileStoreSnapshotCore(state.agentDir())!;
        const revision = getRuntimeAuthProfileStoreMetadataRevision(state.agentDir());
        const databasePath = resolveAuthProfileDatabasePath(state.agentDir());
        const rowsRevision = getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(databasePath);
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const prepare = sqliteRead.prepareAgentAuthProfileRowsRead;
        const read = vi
          .spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead")
          .mockImplementation((options) => {
            const reader = prepare(options);
            return options.databasePath === databasePath
              ? {
                  ...reader,
                  read: async () => {
                    const rows = await reader.read();
                    entered.resolve();
                    await resume.promise;
                    return rows;
                  },
                }
              : reader;
          });
        const loading = modelResolver(state)();
        try {
          await Promise.race([
            entered.promise,
            loading.then(() => {
              throw new Error("Model resolution completed before the publication barrier");
            }),
          ]);
          await markAuthProfileSuccess({
            store: before,
            provider: PROVIDER,
            profileId: PROFILE_ID,
            agentDir: state.agentDir(),
          });
          resume.resolve();
          await expect(loading).resolves.toMatchObject({
            model: { name: `${PROFILE_ID}:api_key` },
          });
          const published = getRuntimeAuthProfileStoreSnapshotCore(state.agentDir())!;
          expect(published.profiles).toEqual(before.profiles);
          expect(published.runtimeExternalProfileIds).toEqual([]);
          expect(published.runtimeExternalProfileIdsAuthoritative).toBe(true);
          expect(published.usageStats?.[PROFILE_ID]?.lastProbeAt).toEqual(expect.any(Number));
          expect(getRuntimeAuthProfileStoreMetadataRevision(state.agentDir())).toBe(revision);
          expect(
            getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(databasePath),
          ).toBeGreaterThan(rowsRevision);
        } finally {
          resume.resolve();
          await Promise.allSettled([loading]);
          read.mockRestore();
        }
      },
    );
  });

  it("reads unchanged credentials once across turns and observes published rotation and addition", async () => {
    await withOpenClawTestState({ label: "model-auth-row-snapshot" }, async (state) => {
      await state.writeAuthProfiles(fixtureStore("fixture-original"));
      const read = vi.spyOn(sqliteWorker, "runSqliteReadOnlyWorker");
      const databasePath = resolveAuthProfileDatabasePath(state.agentDir());
      const reads = () => read.mock.calls.filter(([pathname]) => pathname === databasePath);
      const resolve = modelResolver(state);
      try {
        for (let turn = 0; turn < 8; turn += 1) {
          expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        }
        expect.soft(reads()).toHaveLength(1);

        const rotated: AuthProfileStore = {
          version: 1,
          profiles: {
            [PROFILE_ID]: { type: "token", provider: PROVIDER, token: "fixture-rotated" },
            [`${PROVIDER}:added`]: { type: "api_key", provider: PROVIDER, key: "fixture-added" },
          },
        };
        await state.writeAuthProfiles(rotated);
        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:token`);
        expect((await resolve(`${PROVIDER}:added`)).model?.name).toBe(`${PROVIDER}:added:api_key`);
        const current = await loadAuthProfileStoreForRuntimeAsync(state.agentDir(), {
          readOnly: true,
          allowKeychainPrompt: false,
          externalCli: { mode: "none" },
        });
        expect(current.profiles).toEqual(rotated.profiles);
        expect.soft(reads()).toHaveLength(2);
      } finally {
        read.mockRestore();
      }
    });
  });

  it("observes external same-file writes at the fixed identity-probe boundary", async () => {
    await withOpenClawTestState({ label: "model-auth-row-external-write" }, async (state) => {
      await state.writeAuthProfiles(fixtureStore("fixture-original"));
      const read = vi.spyOn(sqliteWorker, "runSqliteReadOnlyWorker");
      const databasePath = resolveAuthProfileDatabasePath(state.agentDir());
      const resolve = modelResolver(state);
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        const inode = fs.statSync(databasePath).ino;
        const snapshotRevision =
          getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(databasePath);
        const mutationRevision =
          getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(databasePath);
        const rotated: AuthProfileStore = {
          version: 1,
          profiles: {
            [PROFILE_ID]: { type: "token", provider: PROVIDER, token: "fixture-external-rotation" },
          },
        };

        // This low-level commit models another process, which cannot publish host revisions.
        writePersistedAuthProfileStoreRaw(rotated, state.agentDir());
        expect(fs.statSync(databasePath).ino).toBe(inode);
        expect(getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(databasePath)).toBe(
          snapshotRevision,
        );
        expect(getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(databasePath)).toBe(
          mutationRevision,
        );
        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        clock.mockReturnValue(99);
        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        expect(read.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(1);
        clock.mockReturnValue(100);
        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:token`);
        const current = await loadAuthProfileStoreForRuntimeAsync(state.agentDir(), {
          readOnly: true,
          allowKeychainPrompt: false,
          externalCli: { mode: "none" },
        });
        expect(current.profiles).toEqual(rotated.profiles);
        expect
          .soft(read.mock.calls.filter(([pathname]) => pathname === databasePath))
          .toHaveLength(2);
      } finally {
        clock.mockRestore();
        read.mockRestore();
      }
    });
  });

  it("keeps incognito reads outside the main runtime cache even for the same database", async () => {
    await withOpenClawTestState({ label: "model-auth-row-isolation" }, async (state) => {
      await state.writeAuthProfiles(fixtureStore("fixture-main"));
      await state.writeAuthProfiles(fixtureStore("fixture-incognito"), "incognito");
      const read = vi.spyOn(sqliteWorker, "runSqliteReadOnlyWorker");
      const resolve = modelResolver(state);
      const databasePath = resolveAuthProfileDatabasePath(state.agentDir());
      const mainReads = () => read.mock.calls.filter(([pathname]) => pathname === databasePath);
      try {
        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        expect.soft(mainReads()).toHaveLength(1);
        await withAuthProfileStoreAgentDir(state.agentDir(), state.stateDir, async () => {
          expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        });
        expect.soft(mainReads()).toHaveLength(2);

        await withAuthProfileStoreAgentDir(
          state.agentDir("incognito"),
          state.stateDir,
          async () => {
            expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
            const isolated = await loadAuthProfileStoreForRuntimeAsync(state.agentDir(), {
              readOnly: true,
              allowKeychainPrompt: false,
              externalCli: { mode: "none" },
            });
            expect(isolated.profiles[PROFILE_ID]).toEqual({
              type: "api_key",
              provider: PROVIDER,
              key: "fixture-incognito",
            });
          },
        );

        expect((await resolve()).model?.name).toBe(`${PROFILE_ID}:api_key`);
        const main = await loadAuthProfileStoreForRuntimeAsync(state.agentDir(), {
          readOnly: true,
          allowKeychainPrompt: false,
          externalCli: { mode: "none" },
        });
        expect(main.profiles[PROFILE_ID]).toEqual(
          fixtureStore("fixture-main").profiles[PROFILE_ID],
        );
        expect.soft(mainReads()).toHaveLength(2);
      } finally {
        read.mockRestore();
      }
    });
  });
});
