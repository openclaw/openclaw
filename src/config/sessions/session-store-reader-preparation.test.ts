import fs from "node:fs";
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
} from "./session-entry-read-runtime.js";
import type { PreparedSessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import { readExactSessionEntriesWithLifecycle } from "./session-entry-read.worker.js";
import * as preparation from "./session-transcript-worker-resources.js";

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
    );
    if (change === "title") {
      replaceSessionEntrySync(scope, { sessionId: "list-source", updatedAt: 2, label: "after" });
      expect(() => assertCapturedSessionEntryReadSource(source, database)).not.toThrow();
    } else {
      await closeOpenClawAgentDatabasesAsync();
      expect(() => assertCapturedSessionEntryReadSource(source, database)).toThrow();
    }
  }),
);

it("reuses a live worker-prepared source without another qualification and rejects revoked custody", () =>
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
      await withArtifactPreservingStateReads(
        () =>
          withSessionEntriesFromStoreInWorker(
            { agentId: "main", storePath, env, sessionKeys: [sessionKey], projection: "full" },
            async (outer) => {
              const source = outer.result.snapshotSource;
              expect(source).toBeDefined();
              if (!source) {
                throw new Error("Original source provenance missing");
              }
              const count = qualify.mock.calls.length;
              const caller = new AbortController();
              const input = {
                agentId: "main",
                storePath,
                env,
                sessionKeys: [sessionKey],
                projection: "full" as const,
                preparedSource: {
                  ...source,
                  assertCurrent() {
                    outer.assertCurrent();
                    caller.signal.throwIfAborted();
                  },
                },
              };
              await withSessionEntriesFromStoreInWorker(input, async (inner) => {
                expect(inner.result.entries[0]?.entry.sessionId).toBe("prepared");
                expect(inner.result.snapshotSource).toEqual(source);
              });
              expect(qualify.mock.calls.length).toBe(count);
              caller.abort(new Error("caller revoked"));
              await expect(
                withSessionEntriesFromStoreInWorker(input, async () => undefined),
              ).rejects.toThrow("caller revoked");
              expect(qualify.mock.calls.length).toBe(count);
            },
          ),
        { agentDatabases: true },
      );
    } finally {
      qualify.mockRestore();
    }
  }));

it("rejects a locator retargeted after worker qualification before the original snapshot read", () =>
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
    const prepare = preparation.prepareSessionStoreCandidatesInWorker;
    const qualify = vi
      .spyOn(preparation, "prepareSessionStoreCandidatesInWorker")
      .mockImplementation(async (request) => {
        const result = await prepare(request);
        fs.unlinkSync(alias);
        fs.symlinkSync(replacementPath, alias);
        return result;
      });
    const consumed = vi.fn(async () => undefined);
    try {
      await expect(
        withArtifactPreservingStateReads(
          () =>
            withSessionEntriesFromStoreInWorker(
              {
                agentId: "main",
                storePath: alias,
                env,
                sessionKeys: [sessionKey],
                projection: "full",
              },
              consumed,
            ),
          { agentDatabases: true },
        ),
      ).rejects.toThrow(/changed|captured discovery custody/);
      expect(consumed).not.toHaveBeenCalled();
    } finally {
      qualify.mockRestore();
    }
  }));

it("keeps an inspection alias behind an accepted writer on its canonical physical FIFO", () =>
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
      if (request.label === "agent database ordered read admission") {
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
    const pending = withArtifactPreservingStateReads(
      () =>
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
        ),
      { agentDatabases: true },
    );
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
  }));

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
      const prepare = snapshots.prepareSqliteReadOnlyLocationSync;
      const cleanup = vi.fn<(value: ReturnType<typeof prepare>) => boolean>((snapshot) => {
        expect(snapshot.cleanup()).toBe(true);
        expect(fs.existsSync(snapshot.location)).toBe(false);
        return !cleanupFails;
      });
      const capture = vi
        .spyOn(snapshots, "prepareSqliteReadOnlyLocationSync")
        .mockImplementation((...args) => {
          const snapshot = prepare(...args);
          if (missing) {
            fs.unlinkSync(snapshot.location);
          }
          return { ...snapshot, cleanup: () => cleanup(snapshot) };
        });
      try {
        expect(() =>
          readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: { agentId: "main", path: sourcePath },
            env,
            sessionKeys: [sessionKey],
            projection: "full",
            preserveSourceArtifacts: true,
          }),
        ).toThrow(
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
