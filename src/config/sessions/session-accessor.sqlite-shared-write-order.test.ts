import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as writerQueue from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, patchSessionEntryCore } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";

it.each([false, true])(
  "retains shared-store patch order while discovering the physical owner (source guard=%s)",
  async (sourceGuard) => {
    await withOpenClawTestState(
      { label: "session-shared-write-order", scenario: "minimal" },
      async (state) => {
        const storePath = state.statePath("shared.sqlite");
        openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: storePath });
        const scope = {
          env: state.env,
          storePath,
          agentId: "secondary",
          sessionKey: "agent:secondary:fifo",
        };
        const pending: Promise<unknown>[] = [];
        const own = <T>(promise: Promise<T>): Promise<T> => {
          pending.push(promise);
          void promise.catch(() => {});
          return promise;
        };
        replaceSessionEntrySync(scope, { sessionId: "shared", updatedAt: 1 });
        const firstEntered = createDeferred();
        const releaseFirst = createDeferred();
        const secondQueued = createDeferred();
        const resolve = targetWorker.resolveSessionSqliteTargetInWorker;
        let firstResolution = true;
        const observation = vi
          .spyOn(targetWorker, "resolveSessionSqliteTargetInWorker")
          .mockImplementation(async (...args) => {
            const result = await resolve(...args);
            if (firstResolution) {
              firstResolution = false;
              firstEntered.resolve();
              await releaseFirst.promise;
            }
            return result;
          });
        let watchSecond = false;
        const realQueued = writerQueue.runQueuedStoreWrite;
        const queued = vi
          .spyOn(writerQueue, "runQueuedStoreWrite")
          .mockImplementation(<T>(params: Parameters<typeof realQueued<T>>[0]) => {
            const result = realQueued<T>(params);
            if (watchSecond && params.storePath === storePath) {
              secondQueued.resolve();
            }
            return result;
          });
        const order: string[] = [];
        const patch = (label: string) =>
          own(
            patchSessionEntryCore(
              scope,
              () => {
                order.push(label);
                return { label };
              },
              {
                skipMaintenance: true,
                ...(sourceGuard ? { workerGuard: { source: () => {} } } : {}),
              },
            ),
          );
        const first = patch("first");
        try {
          await awaitGateBeforeSettlement(
            firstEntered.promise,
            first,
            "First patch settled before physical-owner discovery",
          );
          watchSecond = true;
          const second = patch("second");
          await awaitGateBeforeSettlement(
            secondQueued.promise,
            second,
            "Second patch settled before reaching the shared writer FIFO",
          );
          releaseFirst.resolve();
          await Promise.all([first, second]);
          expect(order).toEqual(["first", "second"]);
          expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "shared", label: "second" });
        } finally {
          releaseFirst.resolve();
          await Promise.allSettled(pending);
          observation.mockRestore();
          queued.mockRestore();
        }
      },
    );
  },
);

it("completes a shared-store patch inside its existing foreground writer", async () => {
  await withOpenClawTestState(
    { label: "session-shared-write-reentry", scenario: "minimal" },
    async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const database = { agentId: "main", env: state.env, path: storePath };
      openOpenClawAgentDatabase(database);
      const scope = {
        env: state.env,
        storePath,
        agentId: "secondary",
        sessionKey: "agent:secondary:nested",
      };
      replaceSessionEntrySync(scope, { sessionId: "nested", updatedAt: 1 });
      const started = createDeferred();
      const submitted = createDeferred();
      const realQueued = writerQueue.runQueuedStoreWrite;
      let observeNested = false;
      const queued = vi
        .spyOn(writerQueue, "runQueuedStoreWrite")
        .mockImplementation(<T>(params: Parameters<typeof realQueued<T>>[0]) => {
          if (!observeNested || params.storePath !== storePath) {
            return realQueued<T>(params);
          }
          observeNested = false;
          const result = realQueued<T>({
            ...params,
            fn: () => {
              started.resolve();
              return params.fn();
            },
          });
          submitted.resolve();
          return result;
        });
      let nested: ReturnType<typeof patchSessionEntryCore> | undefined;
      try {
        await expect(
          runOpenClawAgentWriteAdmission(database, async () => {
            observeNested = true;
            nested = patchSessionEntryCore(scope, () => ({ label: "nested commit" }), {
              skipMaintenance: true,
            });
            void nested.catch(() => {});
            // Detect self-queueing before awaiting a child that cannot then make progress.
            const entered = await Promise.race([
              started.promise.then(() => true),
              submitted.promise.then(() => false),
            ]);
            if (!entered) {
              throw new Error("Nested shared patch queued behind its own foreground writer");
            }
            return await nested;
          }),
        ).resolves.toMatchObject({ sessionId: "nested", label: "nested commit" });
        expect(loadSessionEntry(scope)).toMatchObject({ label: "nested commit" });
      } finally {
        await nested?.catch(() => undefined);
        queued.mockRestore();
      }
    },
  );
});

it("rejects a shared-store replacement during discovery before invoking the updater", async () => {
  await withOpenClawTestState(
    { label: "session-shared-write-replacement", scenario: "minimal" },
    async (state) => {
      const storePath = state.statePath("shared.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: storePath });
      const scope = {
        env: state.env,
        storePath,
        agentId: "secondary",
        sessionKey: "agent:secondary:replaced",
      };
      replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
      await closeOpenClawAgentDatabaseByPathAsync(storePath);
      const entered = createDeferred();
      const release = createDeferred();
      const resolve = targetWorker.resolveSessionSqliteTargetInWorker;
      const observation = vi
        .spyOn(targetWorker, "resolveSessionSqliteTargetInWorker")
        .mockImplementation(async (...args) => {
          const result = await resolve(...args);
          entered.resolve();
          await release.promise;
          return result;
        });
      const update = vi.fn(() => ({ label: "must not commit" }));
      const pending = patchSessionEntryCore(scope, update, { skipMaintenance: true });
      void pending.catch(() => {});
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Patch settled before physical-owner discovery",
        );
        const original = state.statePath("original.sqlite");
        await fs.rename(storePath, original);
        await fs.copyFile(original, storePath);
        release.resolve();
        await expect(pending).rejects.toThrow(
          "Agent database target changed before write admission",
        );
        expect(update).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        observation.mockRestore();
      }
    },
  );
});
