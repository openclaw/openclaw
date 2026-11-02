import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activateGatewayAgentDatabaseStartup } from "../gateway/server-agent-database-startup.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "../gateway/session-restart-resume.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readAgentDatabaseAdmissionRefusal,
  readAgentDatabaseReadAdmissionRefusal,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { invalidateOpenClawAgentDatabaseValidation as invalidateValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase as openAgent,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { withOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";

type NativeIntegrityFixture = {
  makeEnv: (prefix: string) => { OPENCLAW_STATE_DIR: string };
};

export function registerRestartRecoveryAdmissionTests({ makeEnv }: NativeIntegrityFixture): void {
  it.for(["ready", "read-pending", "shared", "refused", "aborted"] as const)(
    "recovers retained inputs without holding unrelated ready stores (%s)",
    async (outcome, { signal }) => {
      const env = makeEnv("restart-admission-");
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      const sharedStore =
        outcome === "shared" ? path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite") : undefined;
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ready: {} } },
        ...(sharedStore ? { session: { store: sharedStore } } : {}),
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: { scopes: ["operator.write"], agents: "*", sessions: { others: "none" } },
              reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const profile = ensureProfileForEmail("restart-admission@example.test");
      const scope = {
        agentId: "main",
        env,
        ...(sharedStore ? { storePath: sharedStore } : {}),
        sessionKey: "agent:main:restart-admission",
        sessionId: "main-restart-admission",
      };
      const readyScope = {
        ...scope,
        agentId: "ready",
        sessionKey: "agent:ready:restart-admission",
        sessionId: "ready-restart-admission",
      };
      const targets = [scope, readyScope];
      const marker = { queuedInputIds: [], hadBackgroundExec: true };
      try {
        for (const target of targets) {
          replaceSessionEntrySync(target, {
            sessionId: target.sessionId,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.id },
          });
          const processSession = createProcessSessionFixture({
            id: `${target.agentId}-restart-work`,
            backgrounded: true,
          });
          processSession.agentId = target.agentId;
          processSession.sessionKey = target.sessionKey;
          processSession.scopeKey = target.sessionKey;
          addSession(processSession);
        }
        await persistRunningSessionsForRestart({ cfg: config });
      } finally {
        resetProcessRegistryForTests();
      }
      for (const target of targets) {
        expect((await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart).toEqual(
          marker,
        );
      }
      const legacyScope =
        outcome === "ready"
          ? {
              ...scope,
              sessionKey: "agent:main:legacy-restart-admission",
              sessionId: "legacy-restart-admission",
            }
          : undefined;
      const database = openAgent({ ...scope, ...(sharedStore ? { path: sharedStore } : {}) });
      if (legacyScope) {
        // Persisted upgrade input from the retired producer; admission and recovery remain real.
        const legacy = {
          sessionId: legacyScope.sessionId,
          updatedAt: Math.floor(performance.timeOrigin) - 1000,
          status: "interrupted",
          abortedLastRun: true,
          createdActor: { type: "human", source: "profile", id: profile.id },
          mainRestartRecovery: { cycleId: "legacy-restart-cycle", revision: 1, chargedAttempts: 0 },
        };
        database.db
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES (?, ?, ?, ?, 1)",
          )
          .run(
            legacyScope.sessionKey,
            legacyScope.sessionId,
            JSON.stringify(legacy),
            legacy.updatedAt,
          );
      }
      setUserProfileRole(profile.id, "reader");
      const pathname = database.path;
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      {
        using db = openNodeSqliteDatabase(pathname);
        db.exec("UPDATE session_key_contract SET canonical_ready=NULL");
      }
      invalidateValidation(pathname);
      revokeSqliteDatabaseAdmissionsForPath(pathname);

      await withAgentDatabaseStartupAdmission(async (admission) => {
        await withOpenClawStateDatabaseReadSnapshot(
          () => assertOpenClawDatabasesReady({ env, config, operation: "gateway-startup" }),
          { env },
        );
        const owner = admission.adopt();
        const openingEntered = createDeferredCore();
        const openingReady = createDeferredCore();
        const recovery = new AbortController();
        const recoverySignal = AbortSignal.any([signal, recovery.signal]);
        const readyRecovered = createDeferredCore();
        const warn = vi.fn((message: string) => {
          if (message.startsWith(`Skipped restart resume for ${readyScope.sessionKey}:`)) {
            readyRecovered.resolve();
          }
        });
        const context = createContext([], () => config);
        context.agentDatabaseStartup = admission.observation;
        const preparationReady = createDeferredCore();
        const inputRecoveryReady = createDeferredCore();
        const inputRecoveryEntered = createDeferredCore();
        if (outcome !== "read-pending") {
          preparationReady.resolve();
        }
        let resuming: Promise<void> | undefined;
        try {
          const activate = admission.activate.bind(admission);
          // Keep native opening and the production migration/recovery adapter. This fixture
          // reaches a revoked principal before inference; model publication is independent.
          vi.spyOn(admission, "activate").mockImplementation((activation) =>
            activate({
              ...activation,
              publishAgent: async () => {},
              openAgent: async (input) => {
                if (input.agentId === "main") {
                  openingEntered.resolve();
                  await openingReady.promise;
                }
                return activation.openAgent(input);
              },
              migrateAgent: async (input) => {
                if (input.agentId === "main" && outcome === "refused") {
                  throw new Error("fixture startup preparation failed");
                }
                const migrated = await activation.migrateAgent(input);
                const recoverInputs = migrated ? migrated.recoverInputs : undefined;
                return {
                  // Advisory transcript maintenance is not part of recovery admission.
                  recoverInputs:
                    recoverInputs &&
                    (async () => {
                      inputRecoveryEntered.resolve();
                      await inputRecoveryReady.promise;
                      await recoverInputs();
                    }),
                };
              },
            }),
          );
          const registry = createEmptyPluginRegistry();
          const startup = {
            admission,
            context,
            preparationReady: preparationReady.promise,
            waitForPostReadyWork: async () => {},
            getConfig: () => config,
            getPluginRegistry: () => registry,
            getPluginMetadataSnapshot: () => undefined,
            isCurrent: () => !signal.aborted,
            log: { info() {}, warn },
          };
          activateGatewayAgentDatabaseStartup(startup);
          if (outcome === "read-pending") {
            expect(readAgentDatabaseReadAdmissionRefusal("main", { env })).toBeDefined();
          } else {
            await withinTest(openingEntered.promise, signal);
            expect(readAgentDatabaseReadAdmissionRefusal("main", { env })).toBeUndefined();
          }
          await admission.waitForAgentPreparation("ready", { signal });
          expect(readAgentDatabaseAdmissionRefusal("main", { env })).toMatchObject({
            code: "agent-database-inspection-pending",
          });
          expect(readAgentDatabaseAdmissionRefusal("ready", { env })).toBeUndefined();

          resuming = resumeMarkedSessions({ context, signal: recoverySignal, log: { warn } });
          void resuming.catch(() => {});
          // Initial discovery must finish even while another store is unreadable or write-pending.
          await withinTest(resuming, signal);
          if (!sharedStore) {
            await withinTest(readyRecovered.promise, signal);
            expect(
              (await readSessionEntryReadOnlyInWorker(readyScope))?.resumeAfterRestart,
            ).toBeUndefined();
          }
          if (outcome !== "read-pending") {
            expect((await readSessionEntryReadOnlyInWorker(scope))?.resumeAfterRestart).toEqual(
              marker,
            );
          }
          expect(warn).toHaveBeenCalledTimes(sharedStore ? 0 : 1);
          const pendingPreparation = admission.pendingPreparation;
          expect(pendingPreparation).toBeDefined();
          preparationReady.resolve();
          openingReady.resolve();
          if (outcome !== "refused") {
            await withinTest(
              awaitGateBeforeSettlement(
                inputRecoveryEntered.promise,
                pendingPreparation!,
                "Prepared marked store did not enter restart recovery",
              ),
              signal,
            );
            expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
            // Physical reads/writes are ready, but a fresh input cannot overtake retained work.
            const { waitForAgentInputAdmission } =
              await import("./agent-database-preparation-context.js");
            const input = waitForAgentInputAdmission(sharedStore ? "ready" : "main", {
              ...(sharedStore ? { storePath: sharedStore } : { cfg: config }),
              owner: admission.observation,
              signal,
            });
            expect(input).toBeDefined();
            await withinTest(
              awaitGateBeforeSettlement(
                readSessionEntryReadOnlyInWorker(readyScope),
                input!,
                "Fresh input overtook restart recovery",
              ),
              signal,
            );
            if (outcome === "aborted") {
              const stopping = owner.stop();
              const cancelled = expect(input).rejects.toMatchObject({
                name: "AbortError",
                cause: admission.signal.reason,
              });
              inputRecoveryReady.resolve();
              await withinTest(Promise.all([cancelled, stopping]), signal);
            } else {
              inputRecoveryReady.resolve();
              await withinTest(input!, signal);
            }
          }
          await withinTest(Promise.all([resuming, pendingPreparation]), signal);
          if (outcome === "refused") {
            expect(readAgentDatabaseAdmissionRefusal("main", { env })).toMatchObject({
              code: "agent-database-inspection-failed",
            });
            expect(() => openAgent(scope)).toThrow("fixture startup preparation failed");
            expect(warn).toHaveBeenCalledTimes(1);
          } else if (outcome === "aborted") {
            expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
            expect((await readSessionEntryReadOnlyInWorker(scope))?.resumeAfterRestart).toEqual(
              marker,
            );
            expect(warn).toHaveBeenCalledTimes(1);
            return;
          } else {
            expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
            expect(
              (await readSessionEntryReadOnlyInWorker(scope))?.resumeAfterRestart,
            ).toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(legacyScope ? 3 : 2);
            if (legacyScope) {
              expect(
                (await readSessionEntryReadOnlyInWorker(legacyScope))?.mainRestartRecovery,
              ).toBeUndefined();
              expect(warn).toHaveBeenCalledWith(
                `Skipped restart resume for ${legacyScope.sessionKey}: Error: Session principal has no current run authority.`,
              );
            }
            expect(warn).toHaveBeenCalledWith(
              `Skipped restart resume for ${scope.sessionKey}: Error: Session principal has no current run authority.`,
            );
          }
          await withinTest(resumeMarkedSessions({ context, signal, log: { warn } }), signal);
          expect(warn).toHaveBeenCalledTimes(outcome === "refused" ? 1 : legacyScope ? 3 : 2);
        } finally {
          recovery.abort();
          preparationReady.resolve();
          inputRecoveryReady.resolve();
          openingReady.resolve();
          await owner.stop();
          await Promise.allSettled([resuming]);
        }
      });
    },
  );
}
