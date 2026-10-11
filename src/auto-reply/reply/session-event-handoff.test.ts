import "../../test-utils/prepare-compiled-subprocesses.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.reset.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionReplacement from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { wake } from "../../cron/service/wake.js";
import type { CronJob } from "../../cron/types.js";
import { createGatewayCronTargetResolver } from "../../gateway/server-cron-targets.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  enqueueAutomationSystemEvent,
  enqueueSystemEvent,
  prepareAutomationSystemEvents,
  enqueueRequiredSystemEventEntry,
  isSystemEventTurnOwned,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { registerSessionEventDeletionEnvironmentTests } from "./session-event-deletion-environment.cases.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import { prepareSessionEventTargetForHost } from "./session-event-target.js";
import {
  continuation,
  sessionKey,
  route,
  withTargetFixture,
} from "./session-event-target.test-support.js";
// These cases stop before turn admission. Unexpected dispatch is a failure,
// never a synthetic adoption/settlement supplied by the fixture.
const dispatch = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected reply dispatch for a retired event target");
  }),
);
const eventLogError = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "session-events" ? { ...logger, error: eventLogError } : logger;
    },
  };
});
// mock-isolation: Reject unexpected reply execution; retired-target cases stop before admission.
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

beforeEach(() => {
  eventLogError.mockClear();
  continuation.mockClear();
  dispatch.mockClear();
  resetSystemEventsForTest();
  gatewayWork.resetGatewayWorkAdmission();
});

afterAll(() => {
  continuation.mockRestore();
});

describe("session event target custody", () => {
  it("keeps a deferred wake for its selected later occurrence through native notice custody", async () => {
    await withTargetFixture(async (state) => {
      const job: CronJob = {
        id: "running-receiver",
        name: "Running receiver",
        agentId: "main",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
        sessionTarget: `session:${sessionKey}`,
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review notices" },
        state: { nextRunAtMs: 1_000, runningAtMs: 1_000 },
      };
      const target = await captureSessionEventTargetForHost("main", sessionKey);
      const adapter = createGatewayCronTargetResolver(state.env, { warn() {} });
      const scheduler = createTestGatewayScheduler();
      const cron = createCronServiceState({
        scheduler,
        cronEnabled: true,
        storePath: "unused-notice-selection-store",
        nowMs: () => 10_000,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        enqueueSystemEvent() {},
        resolveSessionEventTarget: adapter.resolveCronTarget,
        deferSessionEvent: adapter.deferSessionEvent,
        runIsolatedAgentJob: async () => {
          throw new Error("Unexpected isolated execution");
        },
      });
      cron.store = { version: 1, jobs: [job] };
      cron.stopped = false;
      try {
        expect(
          await wake(cron, {
            mode: "next-heartbeat",
            agentId: "main",
            expectedTarget: target,
            text: "Only the next scheduled turn may consume this",
          }),
        ).toEqual({ ok: true });
        const pending = peekSystemEventEntries(sessionKey);
        expect(pending).toHaveLength(1);
        // Advancing wall time cannot redeem the already admitted earlier occurrence.
        for (const runAtMs of [undefined, 1_000, 59_999]) {
          const earlier = await prepareAutomationSystemEvents(sessionKey, job.id, runAtMs);
          try {
            expect(earlier.events).toEqual([]);
            earlier.start();
            expect(peekSystemEventEntries(sessionKey)).toEqual(pending);
          } finally {
            earlier.release();
          }
        }
        const next = await prepareAutomationSystemEvents(sessionKey, job.id, 60_000);
        try {
          expect(next.events).toEqual(pending);
          next.start();
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        } finally {
          next.release();
        }
      } finally {
        await scheduler.stop();
      }
    });
  });

  it.each(["consume", "source-replaced", "next-attempt"] as const)(
    "retains deferred notice custody after ordinary creation closes: %s",
    async (boundary) => {
      await withTargetFixture(
        async (state) => {
          const originalDirectory = state.path("original-store");
          const replacementDirectory = state.path("replacement-store");
          const alias = state.path("event-store");
          await fs.mkdir(originalDirectory);
          await fs.mkdir(replacementDirectory);
          await fs.symlink(originalDirectory, alias, "junction");
          const storePath = path.join(alias, "openclaw-agent.sqlite");
          setRuntimeConfigSnapshot({
            agents: { entries: { main: {} } },
            session: { store: storePath },
          });
          const target = await captureSessionEventTargetForHost("main", sessionKey, {
            env: state.env,
          });
          const prepared = await prepareSessionEventTargetForHost(target, {
            createIfMissing: true,
          });
          let notices: Awaited<ReturnType<typeof prepareAutomationSystemEvents>> | undefined;
          try {
            enqueueAutomationSystemEvent(
              "Deferred first notice",
              { sessionKey },
              {
                jobId: "first-scheduled-turn",
                assertCurrent: () => assertSessionEventTargetCurrent(target),
                prepare: () => prepareSessionEventTargetForHost(target),
              },
            );
            const selected = await prepareAutomationSystemEvents(
              sessionKey,
              "first-scheduled-turn",
            );
            notices = selected;
            const scope = { agentId: "main", storePath, sessionKey };
            const snapshot = await loadReplySessionInitializationSnapshot(scope);
            const committed = await commitReplySessionInitialization({
              ...scope,
              activeSessionKey: sessionKey,
              expectedRevision: snapshot.revision,
              sessionEntry: {
                sessionId: "scheduled-first-session",
                lifecycleRevision: "first",
                updatedAt: 1,
              },
              bindCreation: (operation) => {
                const assertEvent = prepared.bindCreation(operation);
                const assertNotices = selected.bindCreation(operation);
                return () => {
                  assertEvent();
                  assertNotices();
                };
              },
            });
            expect(committed.ok).toBe(true);
            expect(target).toMatchObject({
              sessionId: "scheduled-first-session",
              lifecycleRevision: "first",
            });
            if (boundary === "source-replaced") {
              await fs.unlink(alias);
              await fs.symlink(replacementDirectory, alias, "junction");
              expect(() => selected.start()).toThrow("storage changed after capture");
              expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
                "Deferred first notice",
              ]);
            } else if (boundary === "next-attempt") {
              // beforeStart deferral releases attempt facts without consuming the queued notice.
              selected.release();
              const retry = await prepareAutomationSystemEvents(sessionKey, "first-scheduled-turn");
              try {
                expect(retry.events.map((event) => event.text)).toEqual(["Deferred first notice"]);
                retry.start();
                expect(peekSystemEventEntries(sessionKey)).toEqual([]);
              } finally {
                retry.release();
              }
            } else {
              selected.start();
              expect(peekSystemEventEntries(sessionKey)).toEqual([]);
            }
          } finally {
            notices?.release();
            prepared.release();
          }
        },
        { empty: true, native: true },
      );
    },
  );

  it("retains fresh event custody from a captured Windows short-path spelling", async () => {
    await withTargetFixture(
      async (state) => {
        const root = await fs.realpath(state.path());
        const directory = path.join(root, "EVENT~1");
        const canonicalDirectory = path.join(root, "event-store");
        await fs.mkdir(canonicalDirectory);
        await fs.symlink(canonicalDirectory, directory, "junction");
        const storePath = path.join(directory, "event-store.sqlite");
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {} } },
          session: { store: storePath },
        });
        openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
        const originalLstat = fsSync.lstatSync;
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        // Windows short directory aliases aren't symlinks; the fixture shares real DB/WAL files.
        const lstat = vi
          .spyOn(fsSync, "lstatSync")
          .mockImplementation((pathname, options) =>
            originalLstat(String(pathname) === directory ? canonicalDirectory : pathname, options),
          );
        const originalRead = sessionEntryRead.withSessionEntryReadOnlyInWorker;
        const readCapturedSpelling: typeof originalRead = (
          input,
          assertCurrent,
          consume,
          prepare,
        ) =>
          originalRead(
            input,
            assertCurrent,
            (read, owner) =>
              consume(read, {
                ...owner,
                // Model the historical spelling in transferred metadata; retain native facts/guards.
                selectedStore: owner.selectedStore && {
                  ...owner.selectedStore,
                  physicalPath: storePath,
                },
              }),
            prepare,
          );
        const reader = vi
          .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
          .mockImplementation(readCapturedSpelling);
        let prepared: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
        try {
          const target = await captureSessionEventTargetForHost("main", sessionKey, {
            env: state.env,
          });
          reader.mockRestore();
          prepared = await prepareSessionEventTargetForHost(target, { createIfMissing: true });
          prepared.assertCurrent();
          const scope = { agentId: "main", storePath, sessionKey, env: state.env };
          const snapshot = await loadReplySessionInitializationSnapshot(scope);
          const committed = await commitReplySessionInitialization({
            ...scope,
            activeSessionKey: sessionKey,
            expectedRevision: snapshot.revision,
            sessionEntry: {
              sessionId: "windows-first-session",
              lifecycleRevision: "first",
              updatedAt: 1,
            },
            bindCreation: prepared.bindCreation,
          });
          expect(committed.ok).toBe(true);
          expect(target).toMatchObject({
            sessionId: "windows-first-session",
            lifecycleRevision: "first",
          });
          prepared.assertCurrent();
        } finally {
          prepared?.release();
          reader.mockRestore();
          lstat.mockRestore();
          platform.mockRestore();
        }
      },
      { empty: true, native: true },
    );
  });

  it.each(["before", "after"] as const)(
    "binds cold event capture to storage created %s the worker read",
    async (creation) => {
      await withTargetFixture(
        async ({ env }) => {
          const create = () => {
            const database = openOpenClawAgentDatabase({ agentId: "main", env });
            writeSessionEntry(database, sessionKey, {
              sessionId: "created-during-capture",
              lifecycleRevision: "created-during-capture",
              updatedAt: 1,
            });
          };
          const originalRead = sessionEntryRead.withSessionEntryReadOnlyInWorker;
          const reader = vi
            .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
            .mockImplementation((input, assertCurrent, consume, prepare) =>
              originalRead(
                input,
                assertCurrent,
                async (read, owner) => {
                  if (creation === "after") {
                    create();
                  }
                  return consume(read, owner);
                },
                (database, identity) => {
                  prepare?.(database, identity);
                  expect(identity.key).toMatch(/^path:/);
                  if (creation === "before") {
                    create();
                  }
                },
              ),
            );
          try {
            const capture = captureSessionEventTargetForHost("main", sessionKey, { env });
            if (creation === "after") {
              await expect(capture).rejects.toThrow("storage changed after capture");
              return;
            }
            const target = await capture;
            expect(target).toMatchObject({
              sessionId: "created-during-capture",
              lifecycleRevision: "created-during-capture",
            });
            reader.mockRestore();
            const prepared = await prepareSessionEventTargetForHost(target);
            try {
              prepared.assertCurrent();
            } finally {
              prepared.release();
            }
            expect(dispatch).not.toHaveBeenCalled();
          } finally {
            reader.mockRestore();
          }
        },
        { empty: true, native: true },
      );
    },
  );

  it.for([false, true])(
    "joins cold native preparation before settling cancellation (retained occurrence: %s)",
    async (preserve, { signal }) => {
      await withTargetFixture(
        async ({ env }) => {
          const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
          const prepared = createDeferred();
          const release = createDeferred();
          const cancellation = new AbortController();
          const prepareDatabase = sessionReplacement.prepareSessionEntryReplacementDatabase;
          const preparation = vi
            .spyOn(sessionReplacement, "prepareSessionEntryReplacementDatabase")
            .mockImplementation(async (...args) => {
              await prepareDatabase(...args);
              prepared.resolve();
              cancellation.abort();
              await release.promise;
            });
          const occurrence = preserve
            ? enqueueRequiredSystemEventEntry("Cancelled fresh ingress", { sessionKey })
            : undefined;
          const receipt = enqueueSessionEventForHost("Cancelled fresh ingress", {
            agentId: "main",
            sessionKey,
            source: "plugin",
            expectedTarget: target,
            createIfMissing: true,
            abortSignal: cancellation.signal,
            ...(occurrence
              ? { occurrences: [occurrence], preserveOccurrenceOnRejection: true as const }
              : {}),
          });
          let accepted = false;
          let settled = false;
          void receipt.accepted.then(() => {
            accepted = true;
          });
          void receipt.settled.then(() => {
            settled = true;
          });
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                prepared.promise,
                receipt.settled,
                "event never prepared native storage",
              ),
              signal,
            );
            await Promise.resolve();
            expect(accepted).toBe(false);
            expect(settled).toBe(false);
            if (occurrence) {
              expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(true);
            }
          } finally {
            release.resolve();
            preparation.mockRestore();
            await receipt.settled;
          }
          await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
          await expect(receipt.settled).resolves.toMatchObject({
            status: "cancelled",
            executionStarted: false,
            delivered: false,
          });
          if (occurrence) {
            expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(false);
            expect(peekSystemEventEntries(sessionKey)).toEqual([occurrence]);
          }
          expect(dispatch).not.toHaveBeenCalled();
        },
        { empty: true, native: true },
      );
    },
  );

  it.each(["fresh", "retained", "revoked", "already-revoked", "foreign"] as const)(
    "keeps cold capture read-only and prepares storage only for authorized fresh work: %s",
    async (kind) => {
      await withTargetFixture(
        async ({ env }) => {
          const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
          const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
          expect(target.sessionId).toBe("");
          await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
          if (kind === "fresh") {
            const prepared = await prepareSessionEventTargetForHost(target, {
              createIfMissing: true,
            });
            try {
              prepared.assertCurrent();
              expect((await fs.stat(databasePath)).isFile()).toBe(true);
              const next = await prepareSessionEventTargetForHost(target, {
                createIfMissing: true,
              });
              next.release();
              prepared.assertCurrent();
            } finally {
              prepared.release();
            }
            return;
          }
          if (kind === "foreign") {
            openOpenClawAgentDatabase({ agentId: "main", env });
          }
          let current = kind !== "already-revoked";
          const enqueue = () =>
            enqueueSessionEventForHost("Fresh ingress", {
              agentId: "main",
              sessionKey,
              source: "plugin",
              expectedTarget: target,
              createIfMissing: kind === "retained" ? undefined : true,
              assertAcceptanceCurrent: () => {
                if (!current) {
                  throw new Error("Submitting ingress was revoked");
                }
              },
            });
          if (kind === "already-revoked") {
            expect(enqueue).toThrow("Submitting ingress was revoked");
            expect(peekSystemEventEntries(sessionKey)).toEqual([]);
            await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          const receipt = enqueue();
          current &&= kind !== "revoked";
          const error =
            kind === "retained"
              ? /origin is missing/
              : kind === "revoked"
                ? /ingress was revoked/
                : /storage changed/;
          await expect(receipt.accepted).resolves.toMatchObject({
            ok: false,
            error: expect.stringMatching(error),
          });
          await expect(receipt.settled).resolves.toMatchObject({
            status: "failed",
            executionStarted: false,
          });
          expect(dispatch).not.toHaveBeenCalled();
          if (kind !== "foreign") {
            await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
          }
        },
        { empty: true, native: kind === "fresh" },
      );
    },
  );
  it("captures the original store, route and producer restrictions across asynchronous lookup", async () => {
    await withTargetFixture(async ({ env, path: fixturePath, storePath }) => {
      const suppliedEnv = { ...env };
      const toolsAllow = ["read", "exec"];
      let invocationActive = true;
      let producerActive = true;
      const runId = "event-target-private-producer";
      registerAgentRunContext(runId, { agentId: "main", sessionKey, sessionEventDelivery: false });
      const targetPromise = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          sessionEventToolsAllow: toolsAllow,
          operationalRunInstance: createOperationalRunInstanceRef(runId),
          receiptAuthority: () => invocationActive,
        },
        () =>
          captureSessionEventTargetForHost("main", sessionKey, {
            env: suppliedEnv,
            assertCurrent: () => {
              if (!producerActive) {
                throw new Error("Background producer retired");
              }
            },
          }),
      );
      clearAgentRunContext(runId);
      suppliedEnv.OPENCLAW_STATE_DIR = fixturePath("later-state");
      const target = await targetPromise;
      toolsAllow.push("message");
      invocationActive = false;

      expect(target).toMatchObject({
        agentId: "main",
        sessionKey,
        sessionId: "original-session",
        lifecycleRevision: "original-revision",
        storePath,
        deliveryContext: route,
        deliver: false,
        settings: { permissionMode: "full" },
        toolsAllow: ["read", "exec"],
      });
      // The independently owned producer outlives its creating tool invocation.
      expect(() => assertSessionEventTargetCurrent(target)).not.toThrow();
      producerActive = false;
      expect(() => assertSessionEventTargetCurrent(target)).toThrow("Background producer retired");
      expect(() =>
        enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        }),
      ).toThrow("Background producer retired");
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it.each(["invocation", "producer"] as const)(
    "refuses a target when its %s retires during asynchronous capture",
    async (owner) => {
      await withTargetFixture(async ({ env }) => {
        let active = true;
        const capture = withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey, receiptAuthority: () => owner !== "invocation" || active },
          () =>
            captureSessionEventTargetForHost("main", sessionKey, {
              env,
              assertCurrent: () => {
                if (owner === "producer" && !active) {
                  throw new Error("Background producer retired");
                }
              },
            }),
        );
        active = false;
        await expect(capture).rejects.toThrow(
          owner === "invocation" ? "no longer owns its invocation" : "Background producer retired",
        );
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["session reset", "lifecycle replacement"] as const)(
    "rejects a captured target after %s before dispatching a turn",
    async (change) => {
      await withTargetFixture(async ({ env, storePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey, env },
          {
            sessionId: change === "session reset" ? "replacement-session" : "original-session",
            lifecycleRevision: "replacement-revision",
            updatedAt: 2,
            delivery: normalizeSessionDeliveryState({
              context: { ...route, to: "replacement-target" },
            }),
          },
        );
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });

        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
          delivered: false,
          error: expect.stringContaining("original session generation"),
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["store replacement", "Gateway restart"] as const)(
    "rejects retained target reuse after %s without creating another occurrence",
    async (change) => {
      await withTargetFixture(async ({ env, path: fixturePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        if (change === "store replacement") {
          setRuntimeConfigSnapshot({
            agents: { entries: { main: {} } },
            session: { store: fixturePath("replacement.sqlite") },
          });
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        expect(() =>
          enqueueSessionEventForHost("Process completed", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: target,
          }),
        ).toThrow(change === "store replacement" ? "reset or replaced" : "stale gateway lifecycle");
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["awaited", "ignored"] as const)(
    "reports a queued event's policy failure once with an %s receipt",
    async (receiptUse) => {
      await withTargetFixture(async ({ env }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });
        setRuntimeConfigSnapshot({
          ...getRuntimeConfigSnapshot(),
          tools: { deny: ["write", "message"] },
        });

        if (receiptUse === "awaited") {
          await expect(receipt.settled).resolves.toMatchObject({
            status: "failed",
            executionStarted: false,
            delivered: false,
            error: expect.stringContaining("configuration changed"),
          });
        }
        // Join the independent owner without requiring a producer to consume its receipt.
        await Promise.allSettled(
          continuation.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
        expect(receipt.cancel()).toBe(false);
        resetSystemEventsForTest();
        expect(eventLogError).toHaveBeenCalledExactlyOnceWith("session event execution failed", {
          source: "exec",
          agentId: "main",
          sessionKey,
          eventId: receipt.id,
          error: expect.stringContaining("configuration changed"),
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it("settles a pending occurrence as cancelled when ephemeral queues close", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      try {
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });
        expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([receipt.id]);
        resetSystemEventsForTest();

        await expect(receipt.settled).resolves.toMatchObject({
          status: "cancelled",
          executionStarted: false,
          delivered: false,
        });
        await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
        expect(receipt.cancel()).toBe(false);
        expect(gatewayWork.getGatewaySuspendAdmissionPhase()).toBe("prepared");
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
        expect(eventLogError).not.toHaveBeenCalled();
      } finally {
        suspension?.release();
      }
    });
  });

  it.each(["reject", "cancel", "removed"] as const)(
    "preserves a preexisting passive occurrence only after pre-adoption settlement: %s",
    async (boundary) => {
      await withTargetFixture(async ({ env }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        const occurrence = enqueueRequiredSystemEventEntry("Deferred hook", { sessionKey });
        expect(occurrence).not.toBeNull();
        if (!occurrence) {
          throw new Error("Expected deferred hook occurrence");
        }
        if (boundary === "reject") {
          gatewayWork.markGatewayRestartDraining();
        }
        const receipt = enqueueSessionEventForHost(occurrence.text, {
          agentId: "main",
          sessionKey,
          source: "hook",
          expectedTarget: target,
          occurrences: [occurrence],
          preserveOccurrenceOnRejection: true,
        });
        if (boundary === "cancel") {
          expect(receipt.cancel()).toBe(true);
        } else if (boundary === "removed") {
          resetSystemEventsForTest();
        }
        await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
        await expect(receipt.settled).resolves.toMatchObject({
          status: boundary === "reject" ? "failed" : "cancelled",
          executionStarted: false,
        });
        expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(false);
        expect(peekSystemEventEntries(sessionKey)).toEqual(
          boundary === "removed" ? [] : [occurrence],
        );
        expect(dispatch).not.toHaveBeenCalled();
      });
    },
  );

  it("releases an occurrence when Gateway restart admission refuses the producer", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      gatewayWork.markGatewayRestartDraining();
      const receipt = enqueueSessionEventForHost("Process completed", {
        agentId: "main",
        sessionKey,
        source: "restart",
        expectedTarget: target,
      });

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: expect.stringContaining("GatewayDrainingError"),
      });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
  it("retires a reset generation's deferred notice without poisoning its automation", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const retiredTarget = await captureSessionEventTargetForHost("main", sessionKey, { env });
      enqueueAutomationSystemEvent(
        "Old session notice",
        { sessionKey },
        {
          jobId: "scheduled-review",
          assertCurrent: () => assertSessionEventTargetCurrent(retiredTarget),
          prepare: () => prepareSessionEventTargetForHost(retiredTarget),
        },
      );
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey, env },
        {
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-revision",
          updatedAt: 2,
        },
      );
      const currentTarget = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const currentOwner = {
        assertCurrent: () => assertSessionEventTargetCurrent(currentTarget),
        prepare: () => prepareSessionEventTargetForHost(currentTarget),
      };
      enqueueAutomationSystemEvent(
        "Current session notice",
        { sessionKey },
        {
          ...currentOwner,
          jobId: "scheduled-review",
        },
      );
      enqueueAutomationSystemEvent(
        "Other automation notice",
        { sessionKey },
        {
          ...currentOwner,
          jobId: "other-review",
        },
      );
      enqueueSystemEvent("Ordinary session notice", { sessionKey });

      const prepared = await prepareAutomationSystemEvents(sessionKey, "scheduled-review");
      try {
        expect(prepared.events.map((event) => event.text)).toEqual(["Current session notice"]);
        prepared.start();
        expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
          "Other automation notice",
          "Ordinary session notice",
        ]);
      } finally {
        prepared.release();
      }
      const nextRun = await prepareAutomationSystemEvents(sessionKey, "scheduled-review");
      try {
        expect(nextRun.events).toEqual([]);
        nextRun.start();
      } finally {
        nextRun.release();
      }
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
  it.each(["replaced", "temporarily-missing"] as const)(
    "retires only positively replaced deferred storage: %s",
    async (change) => {
      await withTargetFixture(async (state) => {
        const original = state.path("notice-original");
        const replacement = state.path("notice-replacement");
        const alias = state.path("notice-store");
        await fs.mkdir(original);
        await fs.mkdir(replacement);
        await fs.symlink(original, alias, "junction");
        const storePath = path.join(alias, "openclaw-agent.sqlite");
        for (const directory of [original, replacement]) {
          const database = openOpenClawAgentDatabase({
            agentId: "main",
            path: path.join(directory, "openclaw-agent.sqlite"),
            env: state.env,
          });
          writeSessionEntry(database, sessionKey, {
            sessionId: directory === original ? "original-notice" : "replacement-notice",
            lifecycleRevision: directory === original ? "original" : "replacement",
            updatedAt: 1,
          });
        }
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {} } },
          session: { store: storePath },
        });
        const retiredTarget = await captureSessionEventTargetForHost("main", sessionKey, {
          env: state.env,
        });
        const enqueue = (target: typeof retiredTarget, jobId: string) =>
          enqueueAutomationSystemEvent(
            "Same notice",
            { sessionKey },
            {
              jobId,
              assertCurrent: () => assertSessionEventTargetCurrent(target),
              prepare: () => prepareSessionEventTargetForHost(target),
            },
          );
        enqueue(retiredTarget, "review");
        enqueue(retiredTarget, "other-review");
        enqueueSystemEvent("Ordinary notice", { sessionKey });
        const before = peekSystemEventEntries(sessionKey);
        await fs.unlink(alias);
        if (change === "temporarily-missing") {
          await expect(prepareAutomationSystemEvents(sessionKey, "review")).rejects.toThrow(
            "storage changed after capture",
          );
          expect(peekSystemEventEntries(sessionKey)).toEqual(before);
          await fs.symlink(original, alias, "junction");
        } else {
          await fs.symlink(replacement, alias, "junction");
          const currentTarget = await captureSessionEventTargetForHost("main", sessionKey, {
            env: state.env,
          });
          enqueue(currentTarget, "review");
        }
        const current = peekSystemEventEntries(sessionKey);
        const expectedId = change === "replaced" ? current.at(-1)?.id : before[0]?.id;
        const prepared = await prepareAutomationSystemEvents(sessionKey, "review");
        try {
          expect(prepared.events.map((event) => event.id)).toEqual([expectedId]);
          prepared.start();
        } finally {
          prepared.release();
        }
        expect(peekSystemEventEntries(sessionKey)).toEqual([before[1], before[2]]);
        const next = await prepareAutomationSystemEvents(sessionKey, "review");
        try {
          expect(next.events).toEqual([]);
          next.start();
        } finally {
          next.release();
        }
        expect(dispatch).not.toHaveBeenCalled();
      });
    },
  );
});

registerSessionEventDeletionEnvironmentTests(withTargetFixture, async (error, run) => {
  await dispatch.withImplementation(
    () => {
      throw error;
    },
    async () => {
      await run();
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );
});
