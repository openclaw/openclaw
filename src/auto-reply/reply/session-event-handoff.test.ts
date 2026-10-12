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
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.reset.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionReplacement from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  enqueueRequiredSystemEventEntry,
  isSystemEventTurnOwned,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import { prepareSessionEventTargetForHost } from "./session-event-target.js";
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

const continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
const sessionKey = "agent:main:event-origin";
const route = {
  channel: "telegram",
  to: "-100001",
  accountId: "event-account",
  threadId: "42",
};

async function withTargetFixture(
  run: (fixture: OpenClawTestState & { storePath: string }) => Promise<void>,
  options: { empty?: boolean; native?: boolean } = {},
) {
  await withOpenClawTestState(
    {
      label: "session-event-target",
      ...(options.native ? { env: { OPENCLAW_TEST_FAST: "0" } } : {}),
    },
    async (state) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      openOpenClawStateDatabase({ env: state.env });
      if (!options.empty) {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        writeSessionEntry(database, sessionKey, {
          sessionId: "original-session",
          lifecycleRevision: "original-revision",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context: route }),
          permissionMode: "full",
        });
      }
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
      try {
        await run({ ...state, storePath });
      } finally {
        resetSystemEventsForTest();
        gatewayWork.resetGatewayWorkAdmission();
        await Promise.allSettled(
          continuation.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}

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

  it("re-admits an accepted deferred occurrence under the current policy after a config publication", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      let adoption: TurnAdoptionLifecycle | undefined;
      let readmissionConfig: { tools?: { deny?: string[] } } | undefined;
      dispatch
        .mockImplementationOnce(
          async (params: { replyOptions?: { turnAdoptionLifecycle?: TurnAdoptionLifecycle } }) => {
            adoption = params.replyOptions?.turnAdoptionLifecycle;
            adoption?.onDeferred?.();
            return { deferredToActiveRun: true };
          },
        )
        .mockImplementationOnce(
          async (params: {
            cfg?: { tools?: { deny?: string[] } };
            replyOptions?: { internalEventExecution?: { onStarted?: () => void } };
          }) => {
            readmissionConfig = params.cfg;
            params.replyOptions?.internalEventExecution?.onStarted?.();
            return {};
          },
        );
      const operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: "original-session",
        resetTriggered: false,
      });
      try {
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });
        await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
        const onAdopted = adoption?.onAdopted;
        if (!onAdopted || !adoption) {
          throw new Error(
            "Expected a deferred turn adoption lifecycle for the accepted occurrence",
          );
        }
        // The operator publishes a new config after acceptance, before the occurrence starts.
        setRuntimeConfigSnapshot({
          ...getRuntimeConfigSnapshot(),
          tools: { deny: ["write", "message"] },
        });

        // Adoption under the stale policy rejects; the queued run still holds the old config.
        await expect(onAdopted()).rejects.toThrow("configuration changed");
        adoption.onSettled?.();
        operation.complete();

        // The occurrence is re-admitted from scratch and executes under the published policy.
        await expect(receipt.settled).resolves.toMatchObject({
          status: "completed",
          executionStarted: true,
          delivered: false,
        });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(readmissionConfig?.tools?.deny).toEqual(["write", "message"]);
        // The completed re-admission consumed the occurrence; nothing waits for a later turn.
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        replyRunTesting.resetReplyRunRegistry();
      }
    });
  });

  it("consumes a deferred occurrence the queue owner abandons, even after a config publication", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      let adoption: TurnAdoptionLifecycle | undefined;
      dispatch.mockImplementationOnce(
        async (params: { replyOptions?: { turnAdoptionLifecycle?: TurnAdoptionLifecycle } }) => {
          adoption = params.replyOptions?.turnAdoptionLifecycle;
          adoption?.onDeferred?.();
          return { deferredToActiveRun: true };
        },
      );
      const receipt = enqueueSessionEventForHost("Process completed", {
        agentId: "main",
        sessionKey,
        source: "exec",
        expectedTarget: target,
      });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      if (!adoption) {
        throw new Error("Expected a deferred turn adoption lifecycle for the accepted occurrence");
      }
      setRuntimeConfigSnapshot({
        ...getRuntimeConfigSnapshot(),
        tools: { deny: ["write", "message"] },
      });

      // Stop removes the queued followup before adoption; abandonment is terminal.
      adoption.onAbandoned?.();
      adoption.onSettled?.();

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: expect.stringContaining("abandoned"),
      });
      // No policy re-admission and no passive leak into the next ordinary turn.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

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
});
