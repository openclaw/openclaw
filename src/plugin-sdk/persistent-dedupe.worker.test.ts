import { existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import * as workerClient from "../plugin-state/plugin-state-worker-client.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createChannelReplayGuard,
  createClaimableDedupe,
  createPersistentDedupe,
  createPersistentDedupeImportEntry,
  migratePersistentDedupeLegacyJsonFile,
  resolvePersistentDedupePluginStateNamespace,
} from "./persistent-dedupe.js";

const options = {
  pluginId: "dedupe-worker-proof",
  namespacePrefix: "replay",
  stateMaxEntries: 2,
  memoryMaxSize: 0,
  ttlMs: 60_000,
};

afterEach(() => vi.restoreAllMocks());

describe("persistent dedupe worker", () => {
  it.each([
    { operation: "release", readFails: false },
    { operation: "forget", readFails: false },
    { operation: "release", readFails: true },
    { operation: "forget", readFails: true },
  ] as const)(
    "preserves replaced claim settlement after $operation (readFails=$readFails)",
    async ({ operation, readFails }) => {
      await withOpenClawTestState({ label: "dedupe-claim-replacement" }, async () => {
        const lookup = workerClient.lookupPluginStateInWorker;
        const ready = createDeferredCore();
        const gate = createDeferredCore();
        vi.spyOn(workerClient, "lookupPluginStateInWorker").mockImplementationOnce(
          async (params) => {
            const result = await lookup(params);
            ready.resolve();
            await gate.promise;
            if (readFails) {
              throw new Error("late lookup rejected");
            }
            return result;
          },
        );
        const dedupe = createClaimableDedupe({
          ...options,
          onDiskError: (error: unknown) => {
            throw error;
          },
        });
        const original = dedupe.claim("shared");
        const outcome = original.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await ready.promise;
        const failure = new Error("original owner released");
        const forgetting =
          operation === "forget"
            ? dedupe.forget("shared")
            : dedupe.release("shared", { error: failure });
        const replacement = dedupe.claim("shared");
        try {
          gate.resolve();
          const settled = await outcome;
          expect(settled).toMatchObject({
            error:
              operation === "release"
                ? failure
                : expect.objectContaining({
                    message: expect.stringContaining("claim released before commit"),
                  }),
          });
          if (operation === "release" && "error" in settled) {
            expect(settled.error).toBe(failure);
          }
          await forgetting;
          expect(await replacement).toEqual({ kind: "claimed" });
          const waiter = await dedupe.claim("shared");
          expect(waiter.kind).toBe("inflight");
          dedupe.release("shared", { error: failure });
          if (waiter.kind === "inflight") {
            await expect(waiter.pending).rejects.toBe(failure);
          }
        } finally {
          gate.resolve();
          await Promise.allSettled([original, forgetting, replacement]);
          dedupe.release("shared");
        }
      });
    },
  );

  it("does not let an older commit remove a replacement claim", async () => {
    await withOpenClawTestState({ label: "dedupe-commit-replacement" }, async () => {
      const compare = workerClient.comparePluginStateUpdateInWorker;
      const ready = createDeferredCore();
      const gate = createDeferredCore();
      vi.spyOn(workerClient, "comparePluginStateUpdateInWorker").mockImplementationOnce(
        async (params) => {
          const result = await compare(params);
          ready.resolve();
          await gate.promise;
          return result;
        },
      );
      const dedupe = createClaimableDedupe(options);
      expect(await dedupe.claim("shared")).toEqual({ kind: "claimed" });
      const committing = dedupe.commit("shared");
      await ready.promise;
      const forgetting = dedupe.forget("shared");
      const replacement = dedupe.claim("shared");
      try {
        gate.resolve();
        await Promise.all([committing, forgetting]);
        expect(await replacement).toEqual({ kind: "claimed" });
        const waiter = await dedupe.claim("shared");
        expect(waiter.kind).toBe("inflight");
      } finally {
        gate.resolve();
        await Promise.allSettled([committing, forgetting, replacement]);
        dedupe.release("shared");
      }
    });
  });

  it("retains current memory duplicates when an unrelated forget invalidates pending publication", async () => {
    await withOpenClawTestState({ label: "dedupe-current-memory" }, async () => {
      const dedupe = createPersistentDedupe({
        ...options,
        pluginId: "dedupe-memory-budget",
        memoryMaxSize: 10,
        stateMaxEntries: 1,
      });
      await dedupe.checkAndRecord("first");
      await dedupe.checkAndRecord("second");
      const outcomes = await Promise.all([
        dedupe.checkAndRecord("first"),
        dedupe.forget("unrelated"),
      ]);
      expect(outcomes).toEqual([false, false]);
    });
  });

  it("retains the migration source when admission closes before source deletion", async () => {
    await withOpenClawTestState({ label: "dedupe-migration-retirement" }, async (state) => {
      const now = Date.now();
      const filePath = await state.writeJson("retired.json", { imported: now });
      const compare = workerClient.comparePluginStateUpdateInWorker;
      vi.spyOn(workerClient, "comparePluginStateUpdateInWorker").mockImplementationOnce(
        async (params) => {
          const result = await compare(params);
          await closeOpenClawStateDatabaseAsync();
          return result;
        },
      );
      await expect(
        migratePersistentDedupeLegacyJsonFile({ ...options, filePath, namespace: "global", now }),
      ).rejects.toThrow();
      expect(existsSync(filePath)).toBe(true);
    });
  });

  it.each(["commit", "forget"] as const)(
    "joins all multi-key %s writes before returning failure",
    async (operation) => {
      await withOpenClawTestState({ label: "dedupe-write-settlement" }, async () => {
        const guard = createChannelReplayGuard<{ keys: string[] }>({
          dedupe: {
            ...options,
            onDiskError: (error: unknown) => {
              throw error;
            },
          },
          buildReplayKey: (event) => event.keys,
        });
        const event = { keys: ["first", "second"] };
        if (operation === "forget") {
          const seed = createPersistentDedupe(options);
          await seed.checkAndRecord("first");
          await seed.checkAndRecord("second");
        }
        const failure = new Error("first write failed");
        const ready = createDeferredCore();
        const gate = createDeferredCore();
        const secondDone = createDeferredCore();
        let calls = 0;
        const write = async <T>(run: () => Promise<T>) => {
          if (++calls === 1) {
            throw failure;
          }
          ready.resolve();
          await gate.promise;
          try {
            return await run();
          } finally {
            secondDone.resolve();
          }
        };
        if (operation === "commit") {
          const compare = workerClient.comparePluginStateUpdateInWorker;
          vi.spyOn(workerClient, "comparePluginStateUpdateInWorker").mockImplementation((params) =>
            write(() => compare(params)),
          );
        } else {
          const remove = workerClient.deletePluginStateInWorker;
          vi.spyOn(workerClient, "deletePluginStateInWorker").mockImplementation((params) =>
            write(() => remove(params)),
          );
        }
        let pending: Promise<boolean>;
        if (operation === "commit") {
          const claim = await guard.claim(event);
          if (claim.kind !== "claimed") {
            throw new Error(`Expected replay ownership, got ${claim.kind}`);
          }
          pending = claim.handle.commit();
        } else {
          pending = guard.forget(event);
        }
        let settled = false;
        const outcome = pending.then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        try {
          await ready.promise;
          await setImmediate();
          expect(settled).toBe(false);
        } finally {
          gate.resolve();
          await Promise.all([outcome, secondDone.promise]);
        }
        expect(await outcome).toEqual({ error: failure });
        expect(await createPersistentDedupe(options).hasRecent("second")).toBe(
          operation === "commit",
        );
      });
    },
  );

  it("keeps replay, bounded storage, legacy namespaces and migration SQL off the caller", async () => {
    await withOpenClawTestState({ label: "persistent-dedupe-worker" }, async (state) => {
      const native = requireNodeSqlite();
      const sql = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(native.StatementSync.prototype, method),
        ),
      ];
      try {
        const dedupe = createPersistentDedupe(options);
        expect(await dedupe.hasRecent("missing")).toBe(false);
        expect(await dedupe.checkAndRecord("first")).toBe(true);
        expect(await dedupe.checkAndRecord("first")).toBe(false);
        expect(await dedupe.checkAndRecord("second")).toBe(true);
        expect(await dedupe.checkAndRecord("third")).toBe(true);
        expect(await dedupe.hasRecent("first")).toBe(false);
        expect(await dedupe.warmup()).toBe(2);
        expect(await dedupe.forget("second")).toBe(true);
        expect(await dedupe.hasRecent("second")).toBe(false);

        const legacyOptions = {
          ttlMs: 0,
          memoryMaxSize: 0,
          fileMaxEntries: 10,
          resolveFilePath: (namespace: string) => state.path(`${namespace}.json`),
        };
        expect(await createPersistentDedupe(legacyOptions).checkAndRecord("legacy")).toBe(true);
        expect(await createPersistentDedupe(legacyOptions).hasRecent("legacy")).toBe(true);

        const now = Date.now();
        const filePath = await state.writeJson("retired.json", {
          imported: now,
          expired: now - options.ttlMs - 1,
        });
        expect(
          await migratePersistentDedupeLegacyJsonFile({
            ...options,
            filePath,
            namespace: "migration",
            now,
          }),
        ).toEqual({
          imported: 1,
          skippedExpired: 1,
          skippedInvalid: 0,
          skippedExisting: 0,
          removed: true,
        });
        expect(existsSync(filePath)).toBe(false);
        await closeOpenClawStateDatabaseAsync();
        expect(
          await createPersistentDedupe(options).hasRecent("imported", { namespace: "migration" }),
        ).toBe(true);
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        sql.forEach((method) => method.mockRestore());
      }
    });
  });

  it("rechecks concurrent observations so exactly one instance records a new key", async () => {
    await withOpenClawTestState({ label: "dedupe-competing-writers" }, async () => {
      const observe = workerClient.observePluginStateInWorker;
      const ready = createDeferredCore();
      const gate = createDeferredCore();
      let observations = 0;
      vi.spyOn(workerClient, "observePluginStateInWorker").mockImplementation(async (params) => {
        const result = await observe(params);
        if (++observations === 2) {
          ready.resolve();
        }
        await gate.promise;
        return result;
      });
      const first = createPersistentDedupe(options).checkAndRecord("shared");
      const second = createPersistentDedupe(options).checkAndRecord("shared");
      try {
        await ready.promise;
      } finally {
        gate.resolve();
      }
      expect(
        (await Promise.all([first, second])).toSorted(
          (left, right) => Number(left) - Number(right),
        ),
      ).toEqual([false, true]);
    });
  });

  it("retains a newer concurrent row when migrating a retired cache", async () => {
    await withOpenClawTestState({ label: "dedupe-migration-conflict" }, async (state) => {
      const now = Date.now();
      const filePath = await state.writeJson("retired.json", { shared: now - 1_000 });
      const observe = workerClient.observePluginStateInWorker;
      const store = createPluginStateKeyedStore(options.pluginId, {
        namespace: resolvePersistentDedupePluginStateNamespace({ ...options, namespace: "global" }),
        maxEntries: options.stateMaxEntries,
        defaultTtlMs: options.ttlMs,
      });
      vi.spyOn(workerClient, "observePluginStateInWorker").mockImplementationOnce(
        async (params) => {
          const result = await observe(params);
          const newer = createPersistentDedupeImportEntry({ key: "shared", seenAt: now });
          await store.register(newer.key, newer.value);
          return result;
        },
      );
      expect(
        await migratePersistentDedupeLegacyJsonFile({
          ...options,
          filePath,
          namespace: "global",
          now,
        }),
      ).toMatchObject({ imported: 0, skippedExisting: 1, removed: true });
      expect((await store.entries()).map(({ value }) => value)).toEqual([
        { key: "shared", seenAt: now },
      ]);
    });
  });

  it.each([false, true])(
    "orders forget after an unfinished recording (legacy alias=%s)",
    async (legacyAlias) => {
      await withOpenClawTestState({ label: "dedupe-forget-order" }, async (state) => {
        const observe = workerClient.observePluginStateInWorker;
        const ready = createDeferredCore();
        const gate = createDeferredCore();
        vi.spyOn(workerClient, "observePluginStateInWorker").mockImplementationOnce(
          async (params) => {
            const result = await observe(params);
            ready.resolve();
            await gate.promise;
            return result;
          },
        );
        const createDedupe = () =>
          legacyAlias
            ? createPersistentDedupe({
                ttlMs: options.ttlMs,
                memoryMaxSize: 0,
                fileMaxEntries: options.stateMaxEntries,
                resolveFilePath: () => state.path("shared.json"),
              })
            : createPersistentDedupe({ ...options, memoryMaxSize: 10 });
        const dedupe = createDedupe();
        const recording = dedupe.checkAndRecord("forgotten", { namespace: "first" });
        await ready.promise;
        const forgotten = dedupe.forget("forgotten", {
          namespace: legacyAlias ? "alias" : "first",
        });
        try {
          expect(dedupe.memorySize()).toBe(0);
        } finally {
          gate.resolve();
        }
        expect(await recording).toBe(true);
        expect(await forgotten).toBe(true);
        expect(dedupe.memorySize()).toBe(0);
        expect(await createDedupe().hasRecent("forgotten", { namespace: "first" })).toBe(false);
      });
    },
  );

  it("records again after an intervening forget and retains the replacement operation", async () => {
    await withOpenClawTestState({ label: "dedupe-record-forget-record" }, async () => {
      const observe = workerClient.observePluginStateInWorker;
      const entered = [createDeferredCore(), createDeferredCore()];
      const gates = [createDeferredCore(), createDeferredCore()];
      let index = 0;
      vi.spyOn(workerClient, "observePluginStateInWorker").mockImplementation(async (params) => {
        const current = index;
        index += 1;
        const result = await observe(params);
        entered[current]?.resolve();
        await gates[current]?.promise;
        return result;
      });
      const dedupe = createPersistentDedupe({
        ...options,
        memoryMaxSize: 10,
        onDiskError: (error: unknown) => {
          throw error;
        },
      });
      const first = dedupe.checkAndRecord("shared");
      await entered[0]!.promise;
      const forgetting = dedupe.forget("shared");
      const replacement = dedupe.checkAndRecord("shared");
      let duplicate: Promise<boolean> | undefined;
      try {
        gates[0]!.resolve();
        expect(await first).toBe(true);
        expect(await forgetting).toBe(true);
        expect(
          await Promise.race([
            entered[1]!.promise.then(() => "entered"),
            replacement.then(() => "settled"),
          ]),
        ).toBe("entered");
        duplicate = dedupe.checkAndRecord("shared");
        let duplicateResult: boolean | undefined;
        void duplicate.then(
          (value) => {
            duplicateResult = value;
          },
          () => {},
        );
        await setImmediate();
        expect(duplicateResult).toBe(false);
        gates[1]!.resolve();
        expect(await replacement).toBe(true);
        expect(await createPersistentDedupe(options).hasRecent("shared")).toBe(true);
      } finally {
        gates.forEach((gate) => gate.resolve());
        await Promise.allSettled([first, forgetting, replacement, duplicate]);
      }
    });
  });

  it("captures database selection before queueing while later calls follow the new environment", async () => {
    await withOpenClawTestState({ label: "dedupe-queued-source" }, async (state) => {
      await withOpenClawTestState(
        { label: "dedupe-next-source", applyEnv: false },
        async (other) => {
          const observe = workerClient.observePluginStateInWorker;
          const ready = createDeferredCore();
          const gate = createDeferredCore();
          vi.spyOn(workerClient, "observePluginStateInWorker").mockImplementationOnce(
            async (params) => {
              const result = await observe(params);
              ready.resolve();
              await gate.promise;
              return result;
            },
          );
          const dedupe = createPersistentDedupe(options);
          const first = dedupe.checkAndRecord("first");
          await ready.promise;
          const queued = dedupe.checkAndRecord("queued");
          vi.stubEnv("OPENCLAW_STATE_DIR", other.stateDir);
          try {
            gate.resolve();
            expect(await first).toBe(true);
            expect(await queued).toBe(true);
            const original = createPersistentDedupe({ ...options, env: state.env });
            const replacement = createPersistentDedupe({ ...options, env: other.env });
            expect(await original.hasRecent("queued")).toBe(true);
            expect(await replacement.hasRecent("queued")).toBe(false);
            expect(await dedupe.checkAndRecord("later")).toBe(true);
            expect(await replacement.hasRecent("later")).toBe(true);
            expect(await original.hasRecent("later")).toBe(false);
          } finally {
            gate.resolve();
            vi.unstubAllEnvs();
          }
        },
      );
    });
  });

  it("refuses queued writes from a closed admission after the same database is reopened", async () => {
    await withOpenClawTestState({ label: "dedupe-queued-close" }, async () => {
      const observe = workerClient.observePluginStateInWorker;
      const ready = createDeferredCore();
      const gate = createDeferredCore();
      vi.spyOn(workerClient, "observePluginStateInWorker").mockImplementationOnce(
        async (params) => {
          const result = await observe(params);
          ready.resolve();
          await gate.promise;
          return result;
        },
      );
      const dedupe = createPersistentDedupe({
        ...options,
        onDiskError: (error: unknown) => {
          throw error;
        },
      });
      const first = dedupe.checkAndRecord("first");
      await ready.promise;
      const queued = dedupe.checkAndRecord("queued");
      const outcomes = Promise.allSettled([first, queued]);
      try {
        await closeOpenClawStateDatabaseAsync();
        const reopened = createPersistentDedupe(options);
        expect(await reopened.checkAndRecord("replacement")).toBe(true);
        gate.resolve();
        expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
        expect(await reopened.hasRecent("replacement")).toBe(true);
        expect(await reopened.hasRecent("first")).toBe(false);
        expect(await reopened.hasRecent("queued")).toBe(false);
      } finally {
        gate.resolve();
        await outcomes;
      }
    });
  });

  it.each(["clear", "forget"] as const)(
    "does not repopulate memory after %s overtakes warmup",
    async (action) => {
      await withOpenClawTestState({ label: "dedupe-warmup-publication" }, async () => {
        const dedupe = createPersistentDedupe({ ...options, memoryMaxSize: 10 });
        await dedupe.checkAndRecord("stored");
        dedupe.clearMemory();
        const list = workerClient.listPluginStateInWorker;
        const ready = createDeferredCore();
        const gate = createDeferredCore();
        vi.spyOn(workerClient, "listPluginStateInWorker").mockImplementationOnce(async (params) => {
          const result = await list(params);
          ready.resolve();
          await gate.promise;
          return result;
        });
        const warming = dedupe.warmup();
        await ready.promise;
        const clearing = action === "clear" ? dedupe.clearMemory() : dedupe.forget("stored");
        gate.resolve();
        expect(await warming).toBe(0);
        await clearing;
        expect(dedupe.memorySize()).toBe(0);
      });
    },
  );

  it.each([false, true])(
    "preserves disk-error policy without replaying a failed write (strict=%s)",
    async (strict) => {
      await withOpenClawTestState({ label: "dedupe-failed-worker" }, async () => {
        const failure = new Error("worker outcome unavailable");
        const write = vi
          .spyOn(workerClient, "comparePluginStateUpdateInWorker")
          .mockRejectedValueOnce(failure);
        const onDiskError = vi.fn((error: unknown) => {
          if (strict) {
            throw error;
          }
        });
        const dedupe = createPersistentDedupe({ ...options, onDiskError });
        const result = dedupe.checkAndRecord("failed");
        if (strict) {
          await expect(result).rejects.toBe(failure);
        } else {
          await expect(result).resolves.toBe(true);
        }
        expect(write).toHaveBeenCalledOnce();
        expect(onDiskError).toHaveBeenCalledWith(failure);
        expect(await createPersistentDedupe(options).hasRecent("failed")).toBe(false);
      });
    },
  );
});
