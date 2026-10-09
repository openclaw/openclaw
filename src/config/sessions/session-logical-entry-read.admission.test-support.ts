import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveHeartbeatSession } from "../../infra/heartbeat-runner-session.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as registryListing from "../../state/openclaw-agent-db-registry-listing.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";

// Register in the original isolated worker suite, retaining its fixture and test order.
export function registerSessionLogicalEntryAdmissionTests(getState: () => OpenClawTestState) {
  it("shares cold database admission with an immediate heartbeat", async () => {
    const state = getState();
    const agentId = "heartbeat-admission";
    const scope = {
      agentId,
      env: state.env,
      storePath: state.sessionsDir(agentId) + "/sessions.json",
      sessionKey: `agent:${agentId}:hook`,
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
    let held = false;
    const intercept = vi
      .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
      .mockImplementation((...args) => {
        const execution = capture(...args);
        return {
          ...execution,
          async prepare(source: AgentDatabaseRequestExecutionSource): Promise<void> {
            if (!held && execution.agentId === agentId) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            await execution.prepare(source);
          },
        };
      });
    const first = readSessionEntryInWorker(scope);
    let heartbeat: Promise<Awaited<ReturnType<typeof resolveHeartbeatSession>>> | undefined;
    try {
      await awaitGateBeforeSettlement(entered.promise, first, "Hook admission was not held");
      heartbeat = Promise.resolve(
        resolveHeartbeatSession(
          { session: { store: scope.storePath } },
          agentId,
          undefined,
          undefined,
          state.env,
        ),
      );
      void heartbeat.catch(() => {});
      release.resolve();
      await expect(first).resolves.toBeUndefined();
      await expect(heartbeat).resolves.toMatchObject({ entry: undefined });
    } finally {
      release.resolve();
      await Promise.allSettled([first, heartbeat]);
      intercept.mockRestore();
    }
  });

  it("preserves heartbeat entries and SQLite creation without materializing the JSON locator", async () => {
    const state = getState();
    for (const reader of ["native", "worker"] as const) {
      const agentId = `heartbeat-${reader}`;
      const scope = {
        agentId,
        env: state.env,
        storePath: state.sessionsDir(agentId) + "/sessions.json",
        sessionKey: `agent:${agentId}:main`,
      };
      const databasePath = resolveOpenClawAgentSqlitePath(scope);
      const cfg = { session: { store: scope.storePath } };
      expect(fs.existsSync(databasePath)).toBe(false);
      if (reader === "native") {
        expect(loadSessionEntry(scope)).toBeUndefined();
      } else {
        await expect(
          resolveHeartbeatSession(cfg, agentId, undefined, undefined, state.env),
        ).resolves.toEqual({
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          suppressOriginatingContext: false,
          entry: undefined,
        });
      }
      expect(fs.existsSync(databasePath)).toBe(true);
      expect(fs.existsSync(scope.storePath)).toBe(false);
      const entry = {
        sessionId: `heartbeat-${reader}-session`,
        updatedAt: 123,
        lastChannel: "telegram",
        lastTo: "group:operations",
        deliveryContext: { channel: "telegram", to: "group:operations", threadId: 42 },
        heartbeatIsolatedBaseSessionKey: scope.sessionKey,
      };
      replaceSessionEntrySync(scope, entry);
      const native = loadSessionEntry(scope);
      expect(native).toMatchObject(entry);
      await expect(
        resolveHeartbeatSession(cfg, agentId, undefined, undefined, state.env),
      ).resolves.toEqual({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        suppressOriginatingContext: false,
        entry: native,
      });
      expect(fs.existsSync(scope.storePath)).toBe(false);
    }
  });

  it("refuses a successor registration instead of extending the captured pending join", async () => {
    const state = getState();
    const agentId = "bounded-registration";
    const scope = {
      agentId,
      defaultAgentId: agentId,
      env: state.env,
      storePath: state.statePath("pending-registration", agentId, "sessions.json"),
      sessionKey: `agent:${agentId}:missing`,
    };
    const agentPath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(scope)));
    const capture = () =>
      registryListing.captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath,
        admission: captureOpenClawStateWorkerContext({ env: state.env }).admission,
      });
    const first = capture();
    const successor = capture();
    const repeatedJoin = createDeferredCore<Error>();
    let joined = false;
    const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
    const discovery = vi
      .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
      .mockImplementation((...args) => {
        const snapshot = prepare(...args);
        return {
          ...snapshot,
          assertCurrent() {
            try {
              snapshot.assertCurrent();
            } catch (error) {
              if (error instanceof registryListing.AgentDatabaseRegistryPendingError) {
                const settle = error.waitForSettlement;
                vi.spyOn(error, "waitForSettlement").mockImplementation(async () => {
                  if (joined) {
                    repeatedJoin.resolve(new Error("Discovery joined the successor registration"));
                    return settle();
                  }
                  joined = true;
                  first.finish();
                  await settle();
                  successor.begin();
                });
              }
              throw error;
            }
          },
        };
      });
    first.begin();
    const reading = readSessionEntryInWorker(scope).catch((error: unknown) => error);
    try {
      await expect(Promise.race([reading, repeatedJoin.promise])).resolves.toBeInstanceOf(
        registryListing.AgentDatabaseRegistryPendingError,
      );
      expect(joined).toBe(true);
    } finally {
      first.finish();
      successor.finish();
      await reading;
      discovery.mockRestore();
    }
  });

  it.each(
    (["read", "admission"] as const).flatMap((kind) =>
      [false, true].map((revoked) => ({ kind, revoked })),
    ),
  )(
    "waits for pending first registration before a fresh $kind (caller revoked=$revoked)",
    async ({ kind, revoked }) => {
      const state = getState();
      const agentId = `pending-${kind}-${revoked}`;
      const scope = {
        agentId,
        defaultAgentId: agentId,
        env: state.env,
        storePath: state.statePath("pending-registration", agentId, "sessions.json"),
        sessionKey: `agent:${agentId}:missing`,
      };
      const registered = createDeferredCore();
      const release = createDeferredCore();
      const blocked = createDeferredCore();
      const capture = registryListing.captureOpenClawAgentDatabaseRegistration;
      let held = false;
      const registration = vi
        .spyOn(registryListing, "captureOpenClawAgentDatabaseRegistration")
        .mockImplementation((params) => {
          const owned = capture(params);
          if (params.agentId !== agentId) {
            return owned;
          }
          let started = false;
          let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
          return {
            ...owned,
            begin() {
              owned.begin();
              started = true;
            },
            get nativeSettlement() {
              return settlement;
            },
            set nativeSettlement(value: Promise<SqliteWorkerOperationSettlement> | undefined) {
              settlement = value?.then(async (outcome) => {
                if (started && !held) {
                  held = true;
                  registered.resolve();
                  await release.promise;
                }
                return outcome;
              });
            },
          };
        });
      const first = readSessionEntryInWorker(scope);
      let callerCurrent = true;
      const assertCallerCurrent = () => {
        if (!callerCurrent) {
          throw new Error("Pending caller was revoked");
        }
      };
      let second: Promise<unknown> | undefined;
      let restoreDiscovery: (() => void) | undefined;
      try {
        await awaitGateBeforeSettlement(
          registered.promise,
          first,
          "First registration was not held",
        );
        const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
        const discovery = vi
          .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
          .mockImplementation((...args) => {
            const snapshot = prepare(...args);
            return {
              ...snapshot,
              assertCurrent() {
                try {
                  snapshot.assertCurrent();
                } catch (error) {
                  if (error instanceof registryListing.AgentDatabaseRegistryChangedError) {
                    blocked.resolve();
                  }
                  throw error;
                }
              },
            };
          });
        restoreDiscovery = () => discovery.mockRestore();
        second = (async () => {
          if (kind === "read") {
            return readSessionEntryInWorker(scope, assertCallerCurrent);
          }
          const loaded = await loadSessionEntryForAdmission(scope, {
            assertCurrent: assertCallerCurrent,
          });
          try {
            loaded.databaseClaim.assertCurrent();
            return loaded.entry;
          } finally {
            await loaded.databaseClaim.release();
          }
        })();
        void second.catch(() => {});
        await awaitGateBeforeSettlement(
          blocked.promise,
          second,
          "Second discovery missed registration",
        );
        callerCurrent = !revoked;
        release.resolve();
        await expect(first).resolves.toBeUndefined();
        if (revoked) {
          await expect(second).rejects.toThrow("Pending caller was revoked");
        } else {
          await expect(second).resolves.toBeUndefined();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        restoreDiscovery?.();
        registration.mockRestore();
      }
    },
  );

  it.each(["read", "admission"] as const)(
    "joins concurrent first %s requests through the queued database owner",
    async (kind) => {
      const state = getState();
      const agentId = `first-${kind}`;
      const scope = { agentId, env: state.env, sessionKey: `agent:${agentId}:missing` };
      const databasePath = resolveOpenClawAgentSqlitePath(scope);
      expect(fs.existsSync(databasePath)).toBe(false);
      const results = await Promise.allSettled(
        Array.from({ length: 15 }, async () => {
          if (kind === "read") {
            return await readSessionEntryInWorker(scope);
          }
          const loaded = await loadSessionEntryForAdmission(scope);
          try {
            loaded.databaseClaim.assertCurrent();
            return loaded.entry;
          } finally {
            await loaded.databaseClaim.release();
          }
        }),
      );
      expect(results).toEqual(
        Array.from({ length: 15 }, () => ({ status: "fulfilled", value: undefined })),
      );
      expect(fs.existsSync(databasePath)).toBe(true);
    },
  );
}
