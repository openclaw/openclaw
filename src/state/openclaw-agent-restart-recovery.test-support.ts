import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { prepareGatewayStartupSessions } from "../gateway/server-startup-session-migration.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "../gateway/session-restart-resume.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
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
import { prepareOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { withOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";

type NativeIntegrityFixture = {
  makeEnv: (prefix: string) => { OPENCLAW_STATE_DIR: string };
  holdIntegrity: (pathname: string) => {
    entered: () => Promise<unknown>;
    release: () => void;
  };
};

export function registerRestartRecoveryAdmissionTests({
  makeEnv,
  holdIntegrity,
}: NativeIntegrityFixture): void {
  it.for(["ready", "refused", "aborted"] as const)(
    "recovers ready restart stores while native writable admission is pending (%s)",
    async (outcome, { signal }) => {
      const env = makeEnv("restart-admission-");
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ready: {} } },
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
      setUserProfileRole(profile.id, "reader");
      const pathname = openAgent(scope).path;
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
        const integrity = holdIntegrity(pathname);
        const recovery = new AbortController();
        const recoverySignal = AbortSignal.any([signal, recovery.signal]);
        const readyRecovered = createDeferredCore();
        const warn = vi.fn((message: string) => {
          if (message.startsWith(`Skipped restart resume for ${readyScope.sessionKey}:`)) {
            readyRecovered.resolve();
          }
        });
        const context = createContext([], () => config);
        context.agentDatabaseStartup = {
          get hasPendingAgents() {
            return admission.hasPendingAgents;
          },
          waitForAgentPreparation: admission.waitForAgentPreparation.bind(admission),
        };
        let resuming: Promise<void> | undefined;
        try {
          admission.activate({
            isCurrent: () => !signal.aborted,
            preparationReady: Promise.resolve(),
            captureReadAdmission: ({ assertCurrent }) => assertCurrent,
            openAgent: ({ agentId, assertCurrent, signal: openingSignal }) =>
              prepareOpenClawAgentDatabaseExecution({ agentId, env }, assertCurrent, openingSignal),
            migrateAgent: async ({ agentId, assertCurrent }) => {
              if (agentId === "main" && outcome === "refused") {
                throw new Error("fixture startup preparation failed");
              }
              await prepareGatewayStartupSessions({
                cfg: config,
                env,
                agentIds: new Set([agentId]),
                assertCurrent,
                log: { info() {}, warn() {} },
              });
            },
            // Storage recovery reaches the real principal refusal before any model is needed.
            publishAgent: async () => {},
          });
          await withinTest(integrity.entered(), signal);
          await admission.waitForAgentPreparation("ready", { signal });
          expect(readAgentDatabaseReadAdmissionRefusal("main", { env })).toBeUndefined();
          expect(readAgentDatabaseAdmissionRefusal("main", { env })).toMatchObject({
            code: "agent-database-inspection-pending",
          });
          expect(readAgentDatabaseAdmissionRefusal("ready", { env })).toBeUndefined();

          resuming = resumeMarkedSessions({ context, signal: recoverySignal, log: { warn } });
          void resuming.catch(() => {});
          await withinTest(
            awaitGateBeforeSettlement(
              readyRecovered.promise,
              resuming,
              "Ready store did not recover",
            ),
            signal,
          );
          expect(
            (await readSessionEntryReadOnlyInWorker(readyScope))?.resumeAfterRestart,
          ).toBeUndefined();
          expect((await readSessionEntryReadOnlyInWorker(scope))?.resumeAfterRestart).toEqual(
            marker,
          );
          expect(warn).toHaveBeenCalledTimes(1);

          if (outcome === "aborted") {
            recovery.abort(new Error("fixture recovery stopped"));
            await expect(resuming).rejects.toThrow("fixture recovery stopped");
            expect((await readSessionEntryReadOnlyInWorker(scope))?.resumeAfterRestart).toEqual(
              marker,
            );
            return;
          }
          integrity.release();
          await withinTest(Promise.all([resuming, admission.pendingPreparation]), signal);
          if (outcome === "refused") {
            expect(readAgentDatabaseAdmissionRefusal("main", { env })).toMatchObject({
              code: "agent-database-inspection-failed",
            });
            expect(() => openAgent(scope)).toThrow("fixture startup preparation failed");
            expect(warn).toHaveBeenCalledTimes(1);
          } else {
            expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
            expect(
              (await readSessionEntryReadOnlyInWorker(scope))?.resumeAfterRestart,
            ).toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(2);
            expect(warn).toHaveBeenCalledWith(
              `Skipped restart resume for ${scope.sessionKey}: Error: Session principal has no current run authority.`,
            );
          }
          await withinTest(resumeMarkedSessions({ context, signal, log: { warn } }), signal);
          expect(warn).toHaveBeenCalledTimes(outcome === "ready" ? 2 : 1);
        } finally {
          recovery.abort();
          integrity.release();
          await owner.stop();
          await Promise.allSettled([resuming]);
        }
      });
    },
  );
}
