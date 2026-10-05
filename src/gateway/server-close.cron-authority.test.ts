import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as preparedRuntime from "../agents/prepared-model-runtime.js";
import * as cronModelSelection from "../cron/isolated-agent/model-selection.js";
import { prepareCronRunContext } from "../cron/isolated-agent/run-prepare.js";
import * as cronSessionState from "../cron/isolated-agent/run-session-state.js";
import * as cronWorkspace from "../cron/isolated-agent/run-workspace.js";
import { saveCronStore } from "../cron/store.js";
import * as receiptAuthority from "../cron/store/receipt-authority-owner.js";
import { readCronRunReceiptCurrentFactsInDatabase } from "../cron/store/run-receipt-read.js";
import {
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} from "../cron/store/run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "../cron/store/run-receipt-store.test-support.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
  consumeCronStandingGrant,
} from "./operator-approval-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it.for(["save", "consume"] as const)(
  "settles a committed %s and queued receipt finalizer across the real close prelude",
  async (kind, { signal }) => {
    const fixture = await createGatewayMetadataCloseFixture("gateway-cron-authority-close");
    const saveCommitted = createDeferred();
    const releaseSaveReply = createDeferred();
    const finishQueued = createDeferred();
    const finishEntered = createDeferred();
    const releaseFinish = createDeferred();
    const preludeEntered = createDeferred();
    const sessionCommitEntered = createDeferred();
    const releaseSessionCommit = createDeferred();
    const schedulerDrainEntered = createDeferred();
    let sessionWriting: Promise<void> | undefined;
    let cronSession:
      | {
          persist: cronSessionState.PersistCronSessionEntry;
          sessionKey: string;
          sessionId: string;
        }
      | undefined;
    let saving: Promise<void> | undefined;
    let refusing: Promise<void> | undefined;
    let finishing: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let queuedUse: Promise<receiptAuthority.CronReceiptAuthorityUse> | undefined;
    let observation: ReturnType<typeof receiptAuthority.observeCronReceiptAuthority> | undefined;
    let releaseReceipt: (() => void) | undefined;
    try {
      const port = await fixture.reservePort();
      const server = await withinTest(fixture.start(port), signal);
      const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
      const storePath = fixture.state.statePath("cron", "authority-close.json");
      const job = makeCronReceiptJob("accepted-before-close", "main");
      job.payload = { kind: "agentTurn", message: "synthetic", toolsAllow: ["message"] };
      job.scheduledToolPolicy = { version: 1, mode: "trusted" };
      if (kind === "save") {
        const captured = new Error("Cron persistence owner captured");
        const createPersist = cronSessionState.createPersistCronSessionEntry;
        const capture = vi
          .spyOn(cronSessionState, "createPersistCronSessionEntry")
          .mockImplementation((params) => {
            cronSession = {
              persist: createPersist(params),
              sessionKey: params.agentSessionKey,
              sessionId: params.cronSession.sessionEntry.sessionId,
            };
            throw captured;
          });
        const published = vi
          .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
          .mockResolvedValue(undefined);
        const model = vi
          .spyOn(cronModelSelection, "resolveCronModelSelectionOwner")
          .mockResolvedValue({
            agentId: "main",
            agentDir: fixture.state.agentDir(),
            workspaceDir: fixture.state.workspaceDir,
            config: fixture.config,
            metadataSnapshot: createPluginMetadataSnapshotFixture(),
            modelCatalog: { entries: [], routeVariants: [] },
          });
        const workspace = vi.spyOn(cronWorkspace, "prepareCronSessionWorkspace").mockResolvedValue({
          workspaceDir: fixture.state.workspaceDir,
        });
        try {
          await expect(
            prepareCronRunContext({
              input: {
                cfg: fixture.config,
                deps: {},
                job,
                deliveryAttemptFence: null,
                message: "Synthetic close persistence",
                sessionKey: `cron:${job.id}`,
                agentId: "main",
              },
              isFastTestEnv: true,
              onLifecycleInterrupt() {},
            }),
          ).rejects.toBe(captured);
        } finally {
          capture.mockRestore();
          published.mockRestore();
          model.mockRestore();
          workspace.mockRestore();
        }
        const runAgent = workerStore.runSqliteWorkerStoreOperation;
        vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
          <Operations extends SqliteWorkerOperations, T>(
            store: SqliteWorkerStore<Operations>,
            operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
            stateContext?: Parameters<typeof runAgent>[2],
            assertCurrent?: Parameters<typeof runAgent>[3],
            createAdmission?: Parameters<typeof runAgent>[4],
          ) =>
            runAgent(
              store,
              (scope) =>
                operation({
                  execute: async (selected, options) => {
                    if (selected.type === "session.entry.patch.commit") {
                      sessionCommitEntered.resolve();
                      await releaseSessionCommit.promise;
                    }
                    return scope.execute(selected, options);
                  },
                }),
              stateContext,
              assertCurrent,
              createAdmission,
            ),
        );
        const stopScheduler = kernel.scheduler.stop.bind(kernel.scheduler);
        vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
          const stopping = stopScheduler();
          schedulerDrainEntered.resolve();
          return stopping;
        });
      }
      await withinTest(saveCronStore(storePath, { version: 1, jobs: [job] }), signal);
      const handle = claimCronRunReceiptForTest(storePath, job, 1);
      releaseReceipt = () => releaseLocalCronRunReceiptOwnership(handle);
      const context = captureOpenClawStateWorkerContext();
      if (kind === "consume") {
        await insertOperatorApproval({
          approval: {
            id: "close-grant",
            kind: "exec",
            runtimeEpoch: "close-test",
            createdAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
            reviewerDeviceIds: [],
            audienceSessionKeys: [],
            presentation: {
              kind: "exec",
              commandText: "echo close",
              commandPreview: "echo close",
              warningText: null,
              host: "gateway",
              nodeId: null,
              agentId: "main",
              allowedDecisions: ["allow-once", "allow-always", "deny"],
            },
          },
        });
        await resolveOperatorApproval({
          id: "close-grant",
          decision: "allow-always",
          resolver: { kind: "device", id: "reviewer" },
          standingGrant: {
            kind: "cron",
            agentId: handle.agentId,
            cronJobId: job.id,
            jobConfigRevision: handle.configRevision,
            operationBinding: "close-binding",
            expiresAtMs: null,
          },
        });
      }
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const otherPath = fixture.state.statePath("other-authority.sqlite");
      openOpenClawStateDatabase({ path: otherPath, env: fixture.state.env });
      const otherContext = captureOpenClawStateWorkerContext({
        path: otherPath,
        env: fixture.state.env,
      });
      const command = {
        type: "cron.currentReceipt" as const,
        handle,
        includeJob: true,
        includeAvailability: true,
      };
      observation = receiptAuthority.observeCronReceiptAuthority(
        context,
        command,
        readCronRunReceiptCurrentFactsInDatabase(shared, command),
      );
      await withinTest(observation.prepared, signal);
      (await observation.acquireUse({ permission: "message", assertCurrent() {} })).initiate(
        () => undefined,
      );

      const run = stateWorker.runOpenClawStateWorkerOperation;
      let heldSave = false;
      const committedCommand = kind === "save" ? "cron.save" : "operatorApprovals.consumeCronGrant";
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        (captured, operation, options) =>
          run(
            captured,
            (scope) =>
              operation({
                execute: async (selected, executeOptions) => {
                  if (selected.type === "cron.finishReceipt") {
                    finishEntered.resolve();
                    await releaseFinish.promise;
                  }
                  const result = await scope.execute(selected, executeOptions);
                  if (selected.type === committedCommand && !heldSave) {
                    heldSave = true;
                    saveCommitted.resolve();
                    await releaseSaveReply.promise;
                  }
                  return result;
                },
              }),
            options,
          ),
      );
      const enroll = receiptAuthority.withCronReceiptAuthorityMutation;
      vi.spyOn(receiptAuthority, "withCronReceiptAuthorityMutation").mockImplementation(
        (captured, operation, options) => {
          const pending = enroll(captured, operation, options);
          if (options?.settlement) {
            finishQueued.resolve();
          }
          return pending;
        },
      );
      const initiate = vi.fn();
      saving = kernel.connectionWork.track(async () => {
        if (kind === "save") {
          await saveCronStore(storePath, {
            version: 1,
            jobs: [{ ...job, enabled: false }],
          });
          return;
        }
        await consumeCronStandingGrant(
          context,
          {
            agentId: handle.agentId,
            cronJobId: job.id,
            jobConfigRevision: handle.configRevision,
            operationBinding: "close-binding",
            handle,
            recordUse: true,
          },
          () => {},
          async (consume) => {
            const use = await observation!.acquireUse({
              permission: "execution",
              assertCurrent() {},
            });
            try {
              const result = await use.mutate(consume);
              use.initiate(initiate);
              return result;
            } finally {
              use.release();
            }
          },
        );
      });
      void saving.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(
          saveCommitted.promise,
          saving,
          "Mutation never reached native settlement",
        ),
        signal,
      );
      refusing = kernel.connectionWork.track(() =>
        saveCronStore(storePath, {
          version: 1,
          jobs: [{ ...job, name: "must not commit after close" }],
        }),
      );
      void refusing.catch(() => {});
      const useQueued = createDeferred();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        if (cronSession) {
          const session = cronSession;
          kernel.scheduler.schedule({
            id: "cron-session-before-close",
            delayMs: 0,
            run() {
              sessionWriting = session.persist();
              void sessionWriting.catch(() => {});
              return sessionWriting;
            },
          });
        }
        kernel.scheduler.schedule({
          id: "cron-use-before-close",
          delayMs: 0,
          run() {
            queuedUse = observation!.acquireUse({
              permission: "message",
              assertCurrent() {},
              signal: kernel.scheduler.signal,
            });
            useQueued.resolve();
            return queuedUse.catch(() => {});
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        await withinTest(useQueued.promise, signal);
      } finally {
        vi.useRealTimers();
      }
      if (cronSession) {
        await withinTest(
          awaitGateBeforeSettlement(
            sessionCommitEntered.promise,
            expectDefined(sessionWriting, "Accepted cron session persistence"),
            "Cron session persistence did not enter its worker",
          ),
          signal,
        );
      }
      finishing = kernel.connectionWork.track(() =>
        finishCronRunReceiptAsync({
          handle,
          status: "ok",
          finishedAtMs: 3,
        }),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          finishQueued.promise,
          finishing,
          "Receipt finalization did not enroll",
        ),
        signal,
      );
      kernel.requestEntryLifetime.signal.addEventListener("abort", () => preludeEntered.resolve(), {
        once: true,
      });
      let closed = false;
      closing = server
        .close({ reason: "cron authority close regression", restartExpectedMs: 1_500 })
        .then(() => {
          closed = true;
        });
      await withinTest(
        awaitGateBeforeSettlement(
          preludeEntered.promise,
          closing,
          "Gateway missed its close prelude",
        ),
        signal,
      );
      expect(kernel.scheduler.signal.aborted).toBe(true);
      expect(kernel.connectionWork.signal.aborted).toBe(true);
      await expect(
        observation.acquireUse({ permission: "message", assertCurrent() {} }),
      ).rejects.toMatchObject({ reason: "retired" });
      expect(() => observation!.readForPreparation()).toThrow("unavailable");
      await expect(saveCronStore(storePath, { version: 1, jobs: [job] })).rejects.toThrow(
        "unavailable",
      );
      expect(() =>
        receiptAuthority.withCronReceiptAuthorityMutation(otherContext, async () => undefined),
      ).toThrow("unavailable");
      expect(shared.isOpen).toBe(true);
      expect(closed).toBe(false);
      const lateScheduledWork = vi.fn();
      if (cronSession) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          kernel.scheduler.schedule({
            id: "cron-session-after-close",
            delayMs: 0,
            run: lateScheduledWork,
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(lateScheduledWork).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      }

      releaseSaveReply.resolve();
      if (kind === "consume") {
        await expect(withinTest(saving, signal)).rejects.toThrow(/retired|unavailable/);
        expect(initiate).not.toHaveBeenCalled();
      } else {
        await withinTest(saving, signal);
      }
      await expect(queuedUse).rejects.toMatchObject({ reason: "retired" });
      await expect(refusing).rejects.toThrow("unavailable");
      await withinTest(
        awaitGateBeforeSettlement(
          finishEntered.promise,
          finishing,
          "Accepted receipt cleanup was cancelled with its parent",
        ),
        signal,
      );
      expect(shared.isOpen).toBe(true);
      expect(closed).toBe(false);
      releaseFinish.resolve();
      if (sessionWriting) {
        await withinTest(
          awaitGateBeforeSettlement(
            schedulerDrainEntered.promise,
            closing,
            "Gateway close skipped the scheduler join",
          ),
          signal,
        );
        expect(closed).toBe(false);
      }
      releaseSessionCommit.resolve();
      if (sessionWriting) {
        await withinTest(sessionWriting, signal);
      }
      await withinTest(Promise.all([finishing, closing]), signal);
      expect(shared.isOpen).toBe(false);
      expect(() => observation!.readForPreparation()).toThrow();
      const database = new DatabaseSync(context.admission.databasePath, { readOnly: true });
      try {
        expect(
          database
            .prepare("SELECT status, finished_at_ms FROM cron_run_receipts WHERE receipt_id = ?")
            .get(handle.receiptId),
        ).toEqual({ status: "ok", finished_at_ms: 3 });
        expect(
          database
            .prepare("SELECT enabled, name FROM cron_jobs WHERE store_key = ? AND job_id = ?")
            .get(handle.storeKey, job.id),
        ).toEqual({ enabled: kind === "save" ? 0 : 1, name: job.name });
        if (kind === "consume") {
          expect(
            database.prepare("SELECT use_count FROM operator_approval_standing_grants").get(),
          ).toEqual({ use_count: 1 });
        }
      } finally {
        database.close();
      }
      if (cronSession) {
        expect(lateScheduledWork).not.toHaveBeenCalled();
        const agentDatabase = new DatabaseSync(
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env }),
          { readOnly: true },
        );
        try {
          expect(
            agentDatabase
              .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
              .get(cronSession.sessionKey),
          ).toEqual({ current_session_id: cronSession.sessionId });
        } finally {
          agentDatabase.close();
        }
      }
    } finally {
      releaseSaveReply.resolve();
      releaseFinish.resolve();
      releaseSessionCommit.resolve();
      await Promise.allSettled([saving, refusing, finishing, closing, queuedUse, sessionWriting]);
      observation?.release();
      releaseReceipt?.();
      vi.restoreAllMocks();
      await fixture.cleanup();
    }
  },
);
