import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import * as logging from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../../state/agent-database-admission-error.js";
import * as databaseResources from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as databaseExecution from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as maintenanceKick from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import { observeNextPeriodicMaintenance } from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import {
  SqliteMutationWorkerRetiredError,
  withSqliteMutationWorkerLifetime,
} from "./session-accessor.sqlite-worker-request.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

afterEach(() => vi.restoreAllMocks());

it.for([false, true])(
  "joins active maintenance finalization during physical close (alias=%s)",
  async (alias, test) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = {
        agentId: "main",
        env: state.env,
        ...(alias ? { path: state.path("relocated", "shared.sqlite") } : {}),
      };
      const database = openOpenClawAgentDatabase(options);
      replaceSessionEntrySync(
        { ...options, storePath: database.path, sessionKey: "agent:main:maintenance-stale" },
        { sessionId: "maintenance-stale", updatedAt: 1 },
      );
      const canonicalPath = fs.realpathSync.native(database.path);
      await closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
      let requestedPath = canonicalPath;
      if (alias) {
        const aliasDirectory = state.path("shared-store-alias");
        fs.symlinkSync(path.dirname(canonicalPath), aliasDirectory, "junction");
        requestedPath = path.join(aliasDirectory, path.basename(canonicalPath));
      }
      const scope = {
        agentId: alias ? "other" : "main",
        databaseAgentId: "main",
        env: state.env,
        path: requestedPath,
      };
      const releaseFinalizer = createDeferredCore();
      const finalizerEntered = createDeferredCore<() => boolean>();
      const releaseAck = createDeferredCore();
      const releaseStarted = createDeferredCore<{ completion: Promise<void> }>();
      const closeEntered = createDeferredCore<{ completion: Promise<void> }>();
      let insideKick = false;
      let insideExecutorCapture = false;
      const captureExecution = databaseExecution.captureOpenClawAgentDatabaseExecution;
      vi.spyOn(databaseExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
        (...args) => {
          if (!insideKick) {
            return captureExecution(...args);
          }
          insideExecutorCapture = true;
          let execution: ReturnType<typeof captureExecution>;
          try {
            execution = captureExecution(...args);
          } finally {
            insideExecutorCapture = false;
          }
          const release = execution.release.bind(execution);
          vi.spyOn(execution, "release").mockImplementation(() => {
            releaseStarted.resolve({ completion: release() });
            return releaseAck.promise;
          });
          return execution;
        },
      );
      const register = databaseResources.registerOpenClawAgentDatabaseAsyncResource;
      vi.spyOn(databaseResources, "registerOpenClawAgentDatabaseAsyncResource").mockImplementation(
        (resource) => {
          if (!insideKick || insideExecutorCapture || resource.path !== canonicalPath) {
            return register(resource);
          }
          return register({
            ...resource,
            close: () => {
              const completion = resource.close();
              closeEntered.resolve({ completion });
              return completion;
            },
          });
        },
      );
      const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
      let finalization: ReturnType<typeof finalize> | undefined;
      vi.spyOn(
        maintenance,
        "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
      ).mockImplementation((...args) => {
        const isCurrent = args[2]?.isCurrent;
        if (!isCurrent) {
          throw new Error("Automatic maintenance omitted its live owner predicate");
        }
        finalizerEntered.resolve(isCurrent);
        finalization = releaseFinalizer.promise.then(() => finalize(...args));
        return finalization;
      });
      const reclaim = vi.spyOn(reclamationRun, "runSqliteSessionReclamation");
      let nativeClosing: Promise<boolean> | undefined;
      try {
        insideKick = true;
        try {
          maintenanceKick.kickSessionEntryMaintenanceAfterWrite({
            activeSessionKey: `agent:${scope.agentId}:maintenance-close`,
            archiveDirectory: state.sessionsDir(),
            maintenanceConfig: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1d",
            }),
            scope,
            storePath: requestedPath,
          });
        } finally {
          insideKick = false;
        }
        const isCurrent = await withinTest(finalizerEntered.promise, test.signal);
        expect(isCurrent()).toBe(true);
        const dispatchedBeforeClose = reclaim.mock.calls.length;
        nativeClosing = closeOpenClawAgentDatabaseByPathAsync(canonicalPath, "main");
        const { completion: schedulerClosing } = await withinTest(
          awaitGateBeforeSettlement(
            closeEntered.promise,
            nativeClosing,
            "Physical close skipped the maintenance scheduler",
          ),
          test.signal,
        );
        expect(isCurrent()).toBe(false);
        const { completion: released } = await withinTest(releaseStarted.promise, test.signal);
        await withinTest(released, test.signal);
        // Acknowledge real executor release before inspecting the scheduler's own
        // close promise; only the held finalizer may still keep that close pending.
        releaseAck.resolve();
        await releaseAck.promise;
        expect(await Promise.race([schedulerClosing, Promise.resolve("pending")])).toBe("pending");
        releaseFinalizer.resolve();
        await withinTest(Promise.all([nativeClosing, finalization]), test.signal);
        expect(reclaim).toHaveBeenCalledTimes(dispatchedBeforeClose);
      } finally {
        releaseAck.resolve();
        releaseFinalizer.resolve();
        await Promise.allSettled([nativeClosing, finalization]);
      }
    });
  },
);

it.for([
  "retired admission",
  "retired mutation",
  "live admission",
  "live mutation",
  "retired plain error",
  "retired plain mutation",
  "retired wrapped mutation",
  "retired aggregate",
  "retired I/O error",
] as const)(
  "reports automatic maintenance failures accurately for %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env };
      const database = openOpenClawAgentDatabase(scope);
      const request = {
        activeSessionKey: "agent:main:maintenance-close",
        archiveDirectory: state.sessionsDir(),
        maintenanceConfig: resolveMaintenanceConfigFromInput({ mode: "enforce" }),
        scope,
        storePath: database.path,
      };
      const execution = databaseExecution.captureOpenClawAgentDatabaseExecution(scope);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const message = "Agent database execution admission is closed";
      const mutationMessage = "SQLite mutation Worker request was revoked";
      const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
      vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
      const warn = vi.spyOn(logger, "warn");
      vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementationOnce(async () => {
        if (scenario === "retired mutation") {
          return withSqliteMutationWorkerLifetime(
            { ...scope, path: database.path },
            async ({ assertCurrent }) => {
              entered.resolve();
              await resume.promise;
              assertCurrent();
              throw new Error("Retired mutation admitted maintenance");
            },
          );
        }
        entered.resolve();
        await resume.promise;
        if (scenario === "retired admission") {
          // Exercise the actual refusal producer after physical close revoked its owner.
          execution.assertCurrent();
          throw new Error("Retired execution admitted maintenance");
        }
        if (scenario === "live admission") {
          throw new AgentDatabaseExecutionAdmissionClosedError(message);
        }
        if (scenario === "live mutation") {
          throw new SqliteMutationWorkerRetiredError();
        }
        if (scenario === "retired plain error") {
          throw new Error(message);
        }
        if (scenario === "retired plain mutation") {
          throw new Error(mutationMessage);
        }
        if (scenario === "retired wrapped mutation") {
          throw new Error("mutation cleanup failed", {
            cause: new SqliteMutationWorkerRetiredError(),
          });
        }
        if (scenario === "retired aggregate") {
          throw new AggregateError(
            [
              new SqliteMutationWorkerRetiredError(),
              Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }),
            ],
            "mutation and cleanup failed",
          );
        }
        throw new Error("maintenance write failed", {
          cause: Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }),
        });
      });
      const scheduled = observeNextPeriodicMaintenance();
      let closing: Promise<boolean> | undefined;
      try {
        maintenanceKick.kickSessionEntryMaintenanceAfterWrite(request);
        await withinTest(entered.promise, signal);
        if (scenario !== "live admission" && scenario !== "live mutation") {
          closing = closeOpenClawAgentDatabaseByPathAsync(database.path);
        }
        resume.resolve();
        if (closing) {
          await withinTest(closing, signal);
        } else {
          await scheduled(signal);
        }
        if (scenario === "retired admission" || scenario === "retired mutation") {
          expect(warn).not.toHaveBeenCalled();
        } else {
          const expectedErrors = {
            "live admission": message,
            "live mutation": mutationMessage,
            "retired plain error": message,
            "retired plain mutation": mutationMessage,
            "retired wrapped mutation": `mutation cleanup failed | ${mutationMessage}`,
            "retired aggregate": `mutation and cleanup failed | ${mutationMessage} | disk I/O error | SQLITE_IOERR`,
            "retired I/O error": "maintenance write failed | disk I/O error | SQLITE_IOERR",
          };
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "SQLite automatic session maintenance failed",
            {
              error: expectedErrors[scenario],
              path: database.path,
            },
          );
        }
      } finally {
        resume.resolve();
        await Promise.allSettled([closing, execution.release()]);
      }
    });
  },
);
