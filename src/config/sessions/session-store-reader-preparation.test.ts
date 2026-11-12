import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import * as lookup from "../../gateway/session-utils-store-lookup.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import * as queues from "../../shared/store-writer-queue.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  withSessionEntriesFromStoreInWorker,
  withSessionEntriesFromStoresInWorker,
  withSessionStoreReaderInWorker,
} from "./session-entry-read-runtime.js";
import type { PreparedSessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import { readExactSessionEntriesWithLifecycleAsync } from "./session-entry-read.worker.js";
import * as targetPreparation from "./session-store-target-runtime.js";
import * as preparation from "./session-transcript-worker-resources.js";

it("keeps admitted source guards in memory after reading through the worker", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:retained-source";
    replaceSessionEntrySync(
      { agentId: "main", env, sessionKey },
      { sessionId: "retained-source", updatedAt: 1 },
    );
    await withSessionStoreReaderInWorker(
      { agentId: "main", storePath: database.path, env },
      async ({ reader, assertCurrent }) => {
        const read = await reader.readExactEntries({ sessionKeys: [sessionKey], env });
        expect(read.entries[0]?.entry.sessionId).toBe("retained-source");
        const stat = vi.spyOn(fs, "statSync");
        syncBuiltinESMExports();
        try {
          for (let index = 0; index < 5; index++) {
            assertCurrent();
          }
          expect(stat).not.toHaveBeenCalled();
        } finally {
          stat.mockRestore();
          syncBuiltinESMExports();
        }
      },
      { capturePhysicalSource: true },
    );
  }));

it("projects worker discovery config while retaining the host configuration owner", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const key = "agent:main:config-owner";
    replaceSessionEntrySync(
      { agentId: "main", env, sessionKey: key },
      { sessionId: "config-owner", updatedAt: 1 },
    );
    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: database.path },
      gateway: { port: 19471 },
    };
    const run = preparation.targetDiscoveryLane.pool.run.bind(preparation.targetDiscoveryLane.pool);
    const capturedConfigs: OpenClawConfig[] = [];
    const dispatch = vi
      .spyOn(preparation.targetDiscoveryLane.pool, "run")
      .mockImplementation((prepare, options) =>
        run(async () => {
          const input = await (typeof prepare === "function" ? prepare() : prepare);
          if (input.kind === "session-target-prepare" && "config" in input.request) {
            capturedConfigs.push(input.request.config);
          }
          return input;
        }, options),
      );
    const hostLookup = vi.spyOn(lookup, "prepareGatewaySessionStoreTargetReadOnly");
    try {
      await withArtifactPreservingStateReads(
        async () => {
          const result = await resolveGatewaySessionStoreTargetInWorker({
            cfg,
            key,
            agentId: "main",
            env,
            exactRead: true,
          });
          expect(result.store[key]?.sessionId).toBe("config-owner");
        },
        { agentDatabases: true },
      );
      expect(capturedConfigs).toContainEqual({
        agents: cfg.agents,
        session: cfg.session,
        acp: undefined,
      });
      expect(capturedConfigs.every((config) => !Object.hasOwn(config, "gateway"))).toBe(true);
      expect(hostLookup).toHaveBeenCalled();
      expect(hostLookup.mock.calls.every(([input]) => input.cfg === cfg)).toBe(true);
    } finally {
      dispatch.mockRestore();
      hostLookup.mockRestore();
    }
  }));

it.each(["title", "retirement"] as const)("retains ordinary list source across %s", (change) =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:list-source";
    const scope = { agentId: "main", env, sessionKey };
    replaceSessionEntrySync(scope, { sessionId: "list-source", updatedAt: 1, label: "before" });
    const realpath = vi.spyOn(fs.realpathSync, "native");
    const prepare = targetPreparation.prepareSessionStoreReaderCandidates;
    const preparationCalls: number[] = [];
    const capture = vi
      .spyOn(targetPreparation, "prepareSessionStoreReaderCandidates")
      .mockImplementation(async (...args) => {
        const before = realpath.mock.calls.length;
        try {
          return await prepare(...args);
        } finally {
          preparationCalls.push(
            realpath.mock.calls.slice(before).filter(([pathname]) => pathname === database.path)
              .length,
          );
        }
      });
    const source = await withSessionEntriesFromStoreInWorker(
      {
        agentId: "main",
        storePath: database.path,
        env,
        sessionKeys: [sessionKey],
        projection: "list",
      },
      async (read) => {
        expect(read.result.entries[0]?.entry.sessionId).toBe("list-source");
        expect(read.result.source).toBeDefined();
        return read.result.source!;
      },
    ).finally(() => {
      capture.mockRestore();
      realpath.mockRestore();
    });
    expect(preparationCalls).toEqual([0]);
    if (change === "title") {
      replaceSessionEntrySync(scope, { sessionId: "list-source", updatedAt: 2, label: "after" });
      expect(() => assertCapturedSessionEntryReadSource(source, database)).not.toThrow();
    } else {
      await closeOpenClawAgentDatabasesAsync();
      expect(() => assertCapturedSessionEntryReadSource(source, database)).toThrow();
    }
  }),
);

it.each([false, true])(
  "reuses a live prepared source and rejects revoked custody (inspection=%s)",
  (inspection) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const storePath = database.path;
      const sessionKey = "agent:main:prepared";
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey },
        { sessionId: "prepared", updatedAt: 1 },
      );
      await closeOpenClawAgentDatabasesAsync();
      const qualify = vi.spyOn(preparation, "prepareSessionStoreCandidatesInWorker");
      try {
        const read = () =>
          withSessionEntriesFromStoreInWorker(
            { agentId: "main", storePath, env, sessionKeys: [sessionKey], projection: "full" },
            async (outer) => {
              const source = outer.result.snapshotSource ?? outer.result.source;
              expect(source).toBeDefined();
              if (!source || typeof source.databaseIdentity !== "string") {
                throw new Error("Original source provenance missing");
              }
              const count = qualify.mock.calls.length;
              const caller = new AbortController();
              const stat = vi.spyOn(fs, "statSync");
              const realpath = vi.spyOn(fs.realpathSync, "native");
              let ownerCalls = 0;
              const input = {
                agentId: "main",
                storePath,
                env,
                sessionKeys: [sessionKey],
                projection: "full" as const,
                preparedSource: {
                  ...source,
                  databaseIdentity: source.databaseIdentity,
                  assertCurrent() {
                    const before = stat.mock.calls.length + realpath.mock.calls.length;
                    try {
                      outer.assertCurrent();
                      caller.signal.throwIfAborted();
                    } finally {
                      ownerCalls += stat.mock.calls.length + realpath.mock.calls.length - before;
                    }
                  },
                },
              };
              try {
                await withSessionEntriesFromStoreInWorker(input, async (inner) => {
                  expect(inner.result.entries[0]?.entry.sessionId).toBe("prepared");
                  expect(inner.result.snapshotSource ?? inner.result.source).toEqual(source);
                });
                expect(qualify.mock.calls.length).toBe(count);
                // The caller owns its live guard; this reader must not repeat its physical checks.
                if (!inspection) {
                  expect(stat.mock.calls.length + realpath.mock.calls.length - ownerCalls).toBe(0);
                }
                caller.abort(new Error("caller revoked"));
                await expect(
                  withSessionEntriesFromStoreInWorker(input, async () => undefined),
                ).rejects.toThrow("caller revoked");
                expect(qualify.mock.calls.length).toBe(count);
              } finally {
                stat.mockRestore();
                realpath.mockRestore();
              }
            },
          );
        await (inspection
          ? withArtifactPreservingStateReads(read, { agentDatabases: true })
          : read());
      } finally {
        qualify.mockRestore();
      }
    }),
);

it.each([false, true])(
  "rejects a locator retargeted after qualification (inspection=%s)",
  (inspection) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { env } = state;
      const sessionKey = "agent:main:prepared-alias";
      const original = openOpenClawAgentDatabase({ agentId: "main", env });
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey },
        { sessionId: "original", updatedAt: 1 },
      );
      const replacement = openOpenClawAgentDatabase({ agentId: "other", env });
      const originalPath = original.path;
      const replacementPath = replacement.path;
      await closeOpenClawAgentDatabasesAsync();
      const alias = state.path("selected.sqlite");
      fs.symlinkSync(originalPath, alias);
      const prepare = targetPreparation.prepareSessionStoreReaderCandidates;
      const qualify = vi
        .spyOn(targetPreparation, "prepareSessionStoreReaderCandidates")
        .mockImplementation(async (...args) => {
          const result = await prepare(...args);
          fs.unlinkSync(alias);
          fs.symlinkSync(replacementPath, alias);
          return result;
        });
      const consumed = vi.fn(async () => undefined);
      try {
        const read = () =>
          withSessionEntriesFromStoreInWorker(
            {
              agentId: "main",
              storePath: alias,
              env,
              sessionKeys: [sessionKey],
              projection: "full",
            },
            consumed,
          );
        await expect(
          inspection ? withArtifactPreservingStateReads(read, { agentDatabases: true }) : read(),
        ).rejects.toThrow(/changed|captured discovery custody/);
        expect(consumed).not.toHaveBeenCalled();
      } finally {
        qualify.mockRestore();
      }
    }),
);

it.each([false, true])("keeps an alias behind its physical FIFO (inspection=%s)", (inspection) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { env } = state;
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:physical-fifo";
    replaceSessionEntrySync(
      { agentId: "main", env, sessionKey },
      { sessionId: "before", updatedAt: 1 },
    );
    const alias = state.path("fifo.sqlite");
    fs.symlinkSync(database.path, alias);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const enqueued = Promise.withResolvers<void>();
    const writer = runOpenClawAgentWriteAdmission(
      { agentId: "main", path: database.path, env },
      async () => {
        entered.resolve();
        await release.promise;
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey },
          { sessionId: "after", updatedAt: 2 },
        );
      },
    );
    await entered.promise;
    const enqueue = queues.runQueuedStoreWrite;
    const queued = vi.spyOn(queues, "runQueuedStoreWrite").mockImplementation((request) => {
      const pending = enqueue(request);
      const label = inspection
        ? "agent database ordered read admission"
        : "agent database write admission";
      if (request.label === label) {
        expect(request.storePath).toBe(fs.realpathSync(database.path));
        expect(request.queues.get(request.storePath)?.pending).toHaveLength(1);
        enqueued.resolve();
      }
      return pending;
    });
    const consume = vi.fn(
      (reads: readonly PreparedSessionEntryWorkerRead[]) =>
        reads[0]?.result.entries[0]?.entry.sessionId,
    );
    const read = () =>
      withSessionEntriesFromStoresInWorker(
        [
          {
            agentId: "main",
            storePath: alias,
            env,
            sessionKeys: [sessionKey],
            projection: "full",
          },
        ],
        consume,
        { ordered: true },
      );
    const pending = inspection
      ? withArtifactPreservingStateReads(read, { agentDatabases: true })
      : read();
    try {
      await Promise.race([
        enqueued.promise,
        pending.then(() => {
          throw new Error("Read completed before physical FIFO enqueue");
        }),
      ]);
      expect(consume).not.toHaveBeenCalled();
      release.resolve();
      await writer;
      expect(await pending).toBe("after");
      expect(consume).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([writer, pending]);
      queued.mockRestore();
    }
  }),
);

it.each([
  [true, false],
  [true, true],
  [false, true],
] as const)(
  "keeps snapshot read failure distinct from cleanup (missing=%s, cleanupFails=%s)",
  (missing, cleanupFails) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:snapshot-failure";
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey },
        { sessionId: "snapshot", updatedAt: 1 },
      );
      const sourcePath = database.path;
      await closeOpenClawAgentDatabasesAsync();
      const prepare = snapshots.prepareSqliteReadOnlyLocationAwaited;
      const cleanup = vi.fn<(value: Awaited<ReturnType<typeof prepare>>) => Promise<boolean>>(
        async (snapshot) => {
          expect(await snapshot.cleanupAsync()).toBe(true);
          expect(fs.existsSync(snapshot.location)).toBe(false);
          return !cleanupFails;
        },
      );
      const capture = vi
        .spyOn(snapshots, "prepareSqliteReadOnlyLocationAwaited")
        .mockImplementation(async (...args) => {
          const snapshot = await prepare(...args);
          if (missing) {
            fs.unlinkSync(snapshot.location);
          }
          return { ...snapshot, cleanupAsync: () => cleanup(snapshot) };
        });
      try {
        await expect(
          readExactSessionEntriesWithLifecycleAsync(
            {
              kind: "session-exact-entries",
              database: { agentId: "main", path: sourcePath },
              env,
              sessionKeys: [sessionKey],
              projection: "full",
              preserveSourceArtifacts: true,
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow(
          missing
            ? "Session entry read lost its captured physical owner"
            : "Session authority snapshot cleanup failed",
        );
        expect(cleanup).toHaveBeenCalledOnce();
        expect(fs.existsSync(sourcePath)).toBe(true);
      } finally {
        capture.mockRestore();
      }
    }),
);
