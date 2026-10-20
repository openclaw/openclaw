import "../../test-utils/prepare-compiled-subprocesses.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.reset.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionReplacement from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
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
import {
  assertSessionEventTargetCurrent,
  combineSessionEventTargetsForHost,
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
const eventScope = { agentId: "main", sessionKey };
const route = {
  channel: "telegram",
  to: "-100001",
  accountId: "event-account",
  threadId: "42",
};

function joinContinuations() {
  return Promise.allSettled(
    continuation.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
  );
}

function interceptReadOwner(
  intercept: (
    owner: sessionEntryRead.SessionEntryReadWorkerOwner,
  ) =>
    | sessionEntryRead.SessionEntryReadWorkerOwner
    | Promise<sessionEntryRead.SessionEntryReadWorkerOwner>,
) {
  const original = sessionEntryRead.withSessionEntryReadOnlyInWorker;
  return vi
    .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
    .mockImplementation((input, assertCurrent, consume, prepare) =>
      original(
        input,
        assertCurrent,
        (read, owner) => {
          const next = intercept(owner);
          return next instanceof Promise
            ? next.then((value) => consume(read, value))
            : consume(read, next);
        },
        prepare,
      ),
    );
}

async function expectStopped(
  receipt: ReturnType<typeof enqueueSessionEventForHost>,
  status: "failed" | "cancelled",
  error?: string,
) {
  await expect(receipt.settled).resolves.toMatchObject({
    status,
    executionStarted: false,
    delivered: false,
    ...(error ? { error: expect.stringContaining(error) } : {}),
  });
}

function enqueueCompletion(
  expectedTarget: Parameters<typeof enqueueSessionEventForHost>[1]["expectedTarget"],
  options: Omit<
    Parameters<typeof enqueueSessionEventForHost>[1],
    "agentId" | "sessionKey" | "source" | "expectedTarget"
  > = {},
) {
  return enqueueSessionEventForHost("Process completed", {
    ...eventScope,
    source: "exec",
    expectedTarget,
    ...options,
  });
}

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
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        resetSystemEventsForTest();
        gatewayWork.resetGatewayWorkAdmission();
        await joinContinuations();
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}

type TargetFixture = OpenClawTestState & { storePath: string };
const it = baseIt.extend<{
  state: TargetFixture;
  nativeState: TargetFixture;
  coldState: TargetFixture;
}>({
  state: async ({ task: _task }, use) => withTargetFixture(use),
  nativeState: async ({ task: _task }, use) => withTargetFixture(use, { native: true }),
  coldState: async ({ task: _task }, use) => withTargetFixture(use, { empty: true, native: true }),
});

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
  it("cleans settled cron events from their captured store", async ({
    signal,
    coldState: state,
  }) => {
    const baseKey = "agent:main:cron:captured-store";
    const runKey = `${baseKey}:run:original`;
    const captured = {
      agentId: "main",
      env: { ...state.env, OPENCLAW_STATE_DIR: state.path("captured-state") },
      storePath: state.path("captured-sessions.sqlite"),
    };
    const replacement = { agentId: "main", env: state.env, storePath: state.storePath };
    openOpenClawStateDatabase({ env: captured.env });
    for (const [scope, sessionId] of [
      [captured, "captured-session"],
      [replacement, "replacement-session"],
    ] as const) {
      await replaceSessionEntry({ ...scope, sessionKey: baseKey }, { sessionId, updatedAt: 1 });
      await replaceSessionEntry(
        { ...scope, sessionKey: runKey },
        {
          sessionId,
          updatedAt: 1,
          cronRunContinuation: {
            lifecycleRevision: "original",
            phase: "ready",
            basePersisted: true,
          },
        },
      );
    }
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot({ ...cfg, session: { store: captured.storePath } });
    const target = await captureSessionEventTargetForHost("main", runKey, {
      env: captured.env,
    });
    setRuntimeConfigSnapshot({ ...cfg, session: { store: replacement.storePath } });
    const receipt = enqueueSessionEventForHost("Process completed", {
      agentId: "main",
      sessionKey: runKey,
      source: "exec",
      expectedTarget: target,
    });
    receipt.cancel();
    expect(await withinTest(receipt.settled, signal)).toMatchObject({ status: "cancelled" });
    await withinTest(joinContinuations(), signal);
    expect(loadSessionEntry({ ...captured, sessionKey: runKey })).toBeUndefined();
    expect(loadSessionEntry({ ...captured, sessionKey: baseKey })?.sessionId).toBe(
      "captured-session",
    );
    expect(loadSessionEntry({ ...replacement, sessionKey: runKey })?.sessionId).toBe(
      "replacement-session",
    );
  });

  it("rejects deleted-agent events without native journal reads", async ({
    nativeState: state,
  }) => {
    const { env, storePath } = state;
    const observed = observeHostDataSql();
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env }).finally(
      observed.restore,
    );
    expect(observed.queries.filter((sql) => /\bagent_deletion_journal\b/i.test(sql))).toEqual([]);
    expect(target).toMatchObject({
      agentId: "main",
      sessionKey,
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
      storePath,
      deliveryContext: route,
      settings: { permissionMode: "full" },
    });
    expect(() => assertSessionEventTargetCurrent(target)).not.toThrow();
    await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = await begin({
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.path("workspace"),
          sessionsDir: state.sessionsDir("main"),
          phase: "draining",
        });
        expect(() => assertSessionEventTargetCurrent(target)).toThrow(
          "Session event owner is being deleted",
        );
        for (const expectedTarget of [target, undefined]) {
          const receipt = enqueueCompletion(expectedTarget);
          await expectStopped(receipt, "failed", "Session event agent is being deleted");
        }
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        await deletion.rollback();
      },
      { env },
    );
    expect(() => assertSessionEventTargetCurrent(target)).not.toThrow();
    expect(target.deliveryContext).toEqual(route);
  });

  it("captures cold events across an empty usage refresh", async () => {
    const { refreshCostUsageCacheForAgent } =
      await import("../../infra/session-cost-usage-aggregation.js");
    await withTargetFixture(
      async ({ env }) => {
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
        const reader = interceptReadOwner(async (owner) => {
          expect(owner.source).toBeUndefined();
          await expect(refreshCostUsageCacheForAgent({ agentId: "main", env })).resolves.toBe(
            "refreshed",
          );
          return owner;
        });
        try {
          const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
          expect(target.sessionId).toBe("");
          reader.mockRestore();
          await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
          const prepared = await prepareSessionEventTargetForHost(target, {
            createIfMissing: true,
          });
          try {
            prepared.assertCurrent();
            expect((await fs.stat(databasePath)).isFile()).toBe(true);
          } finally {
            prepared.release();
          }
        } finally {
          reader.mockRestore();
        }
      },
      { empty: true, native: true },
    );
  });

  it("preserves custody through Windows short-path spelling", async ({ coldState: state }) => {
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
    const reader = interceptReadOwner((owner) => ({
      ...owner,
      // Transfer the historical spelling but preserve native facts and guards.
      selectedStore: owner.selectedStore && { ...owner.selectedStore, physicalPath: storePath },
    }));
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
  });

  it.for([false, true])(
    "joins cold preparation before cancellation (retained: %s)",
    async (preserve, { signal, coldState: { env } }) => {
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
        ...eventScope,
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
        expect({ accepted, settled }).toEqual({ accepted: false, settled: false });
        if (occurrence) {
          expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(true);
        }
      } finally {
        release.resolve();
        preparation.mockRestore();
        await receipt.settled;
      }
      await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
      await expectStopped(receipt, "cancelled");
      if (occurrence) {
        expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(false);
        expect(peekSystemEventEntries(sessionKey)).toEqual([occurrence]);
      }
    },
  );

  it.each(["fresh", "retained", "revoked", "already-revoked"] as const)(
    "prepares cold storage only for authorized fresh work: %s",
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
          let current = kind !== "already-revoked";
          const enqueue = () =>
            enqueueSessionEventForHost("Fresh ingress", {
              ...eventScope,
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
          const error = kind === "retained" ? /origin is missing/ : /ingress was revoked/;
          await expect(receipt.accepted).resolves.toMatchObject({
            ok: false,
            error: expect.stringMatching(error),
          });
          await expect(receipt.settled).resolves.toMatchObject({
            status: "failed",
            executionStarted: false,
          });
          await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
        },
        { empty: true, native: kind === "fresh" },
      );
    },
  );
  it("retains store, route and producer limits across lookup", async ({
    state: { env, path: fixturePath, storePath },
  }) => {
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
      ...eventScope,
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
    expect(() => enqueueCompletion(target)).toThrow("Background producer retired");
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it.for(["invocation", "producer"] as const)(
    "rejects %s retirement during capture",
    async (owner, { state: { env } }) => {
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
    },
  );

  it.for(["session reset", "lifecycle replacement"] as const)(
    "rejects %s before dispatch",
    async (change, { state: { env, storePath } }) => {
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
      const receipt = enqueueCompletion(target);

      await expectStopped(receipt, "failed", "original session generation");
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    },
  );

  it("logs queued-event policy failure once", async ({ state: { env } }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    let current = true;
    const receipt = enqueueCompletion(target, {
      assertCurrent: () => {
        if (!current) {
          throw new Error("Background producer retired");
        }
      },
    });
    current = false;

    await expectStopped(receipt, "failed", "Background producer retired");
    // Join the independent owner without requiring a producer to consume its receipt.
    await joinContinuations();
    expect(receipt.cancel()).toBe(false);
    resetSystemEventsForTest();
    expect(eventLogError).toHaveBeenCalledExactlyOnceWith("session event execution failed", {
      source: "exec",
      agentId: "main",
      sessionKey,
      eventId: receipt.id,
      error: expect.stringContaining("Background producer retired"),
    });
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("cancels pending occurrences when queues close", async ({ state: { env } }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    try {
      const receipt = enqueueCompletion(target);
      expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([receipt.id]);
      resetSystemEventsForTest();

      await expectStopped(receipt, "cancelled");
      await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
      expect(receipt.cancel()).toBe(false);
      expect(gatewayWork.getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(eventLogError).not.toHaveBeenCalled();
    } finally {
      suspension?.release();
    }
  });

  it.for(["reject", "cancel", "removed"] as const)(
    "preserves passive occurrences after %s settlement",
    async (boundary, { state: { env } }) => {
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
        ...eventScope,
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
    },
  );
});

it("retains one requester until pre-admission cancellation", async ({ signal, state: { env } }) => {
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const guest = createAdmittedRunOperatorAuthority({
    profileId: "guest",
    scopes: ["operator.write"],
    assertCurrent() {},
    retain,
  });
  const admin = createAdmittedRunOperatorAuthority({
    profileId: "admin",
    scopes: ["operator.admin"],
    assertCurrent() {},
  });
  const target = await captureSessionEventTargetForHost("main", sessionKey, {
    env,
    operatorAuthority: guest,
  });
  const other = await captureSessionEventTargetForHost("main", sessionKey, {
    env,
    operatorAuthority: admin,
  });
  expect(() => combineSessionEventTargetsForHost([target, other])).toThrow(
    "different captured destinations",
  );
  const receipt = enqueueSessionEventForHost("Command completed", {
    ...eventScope,
    source: "exec",
    expectedTarget: target,
  });
  expect(receipt.cancel()).toBe(true);
  await expect(withinTest(receipt.settled, signal)).resolves.toMatchObject({
    status: "cancelled",
    executionStarted: false,
  });
  expect(retain).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});
