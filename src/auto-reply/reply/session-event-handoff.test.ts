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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
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
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { buildSessionEventContext } from "./session-event-context.js";
import {
  assertSessionEventTargetCurrent as assertTargetCurrent,
  combineSessionEventTargetsForHost,
  captureSessionEventTargetForHost as captureTarget,
  enqueueSessionEventForHost as enqueueEvent,
} from "./session-event-handoff.js";
import { prepareSessionEventTargetForHost as prepareTarget } from "./session-event-target.js";
// These cases stop before turn admission. Unexpected dispatch is a failure,
// never a synthetic adoption/settlement supplied by the fixture.
const dispatch = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected reply dispatch for a retired event target");
  }),
);
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

type ReadOwner = sessionEntryRead.SessionEntryReadWorkerOwner;
function interceptReadOwner(intercept: (owner: ReadOwner) => ReadOwner | Promise<ReadOwner>) {
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
  receipt: ReturnType<typeof enqueueEvent>,
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
  expectedTarget: Parameters<typeof enqueueEvent>[1]["expectedTarget"],
  options: Omit<
    Parameters<typeof enqueueEvent>[1],
    "agentId" | "sessionKey" | "source" | "expectedTarget"
  > = {},
) {
  return enqueueEvent("Process completed", {
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
  emptyState: TargetFixture;
}>({
  state: async ({ task: _task }, use) => withTargetFixture(use),
  nativeState: async ({ task: _task }, use) => withTargetFixture(use, { native: true }),
  coldState: async ({ task: _task }, use) => withTargetFixture(use, { empty: true, native: true }),
  emptyState: async ({ task: _task }, use) => withTargetFixture(use, { empty: true }),
});

beforeEach(() => {
  continuation.mockClear();
  dispatch.mockClear();
  resetSystemEventsForTest();
  gatewayWork.resetGatewayWorkAdmission();
});

afterAll(() => {
  continuation.mockRestore();
});

describe("session event target custody", () => {
  it("retains scheduled creation restrictions and private skill pins only for absent targets", async ({
    state: _state,
  }) => {
    const profile = ensureProfileForEmail("scheduled-creator@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const guest = {
      agents: ["main"],
      sessions: { others: "none" as const },
      scopes: ["operator.read" as const],
      sandbox: "required" as const,
    };
    const cfg: OpenClawConfig = {
      gateway: { roles: { default: "guest", definitions: { guest } } },
    };
    const actor = { type: "human", source: "profile", id: profile.id } as const;
    const skills = [
      {
        skillId: "00000000-0000-0000-0000-000000000001",
        revision: "1".repeat(64),
        name: "private-report",
        ownerProfileId: profile.id,
      },
    ];
    const job = {
      ...makeCronJob({ sessionTarget: `session:${sessionKey}` }),
      createdActor: actor,
      skillLibrarySelections: skills,
    };
    for (const targetSessionId of ["", "existing-session"]) {
      const ctx = buildSessionEventContext({
        cfg,
        ...eventScope,
        text: "Check the report",
        options: {
          source: "cron",
          scheduledAutomation: {
            occurrence: TEST_SCHEDULED_OCCURRENCE,
            job,
            admissionSource: "operator-schedule",
            assertCurrent: () => {},
          },
        },
        occurrenceId: "scheduled-creation",
        target: { sessionId: targetSessionId, generation: "captured-generation" },
        assertCurrent: () => {},
      });
      expect(ctx.SessionCreation).toEqual(
        targetSessionId
          ? undefined
          : { via: "cron", actor, sandbox: "required", skillLibrarySelections: skills },
      );
    }
  });

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
    const target = await captureTarget("main", runKey, {
      env: captured.env,
    });
    setRuntimeConfigSnapshot({ ...cfg, session: { store: replacement.storePath } });
    const receipt = enqueueEvent("Process completed", {
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

  it("rejects deleted-agent events", async ({ nativeState: state }) => {
    const { env } = state;
    const target = await captureTarget("main", sessionKey, { env });
    {
      using resolution = vi.spyOn(path, "resolve");
      for (let index = 0; index < 10_000; index += 1) {
        assertTargetCurrent(target);
      }
      expect(resolution.mock.calls.length).toBe(0);
    }
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
        expect(() => assertTargetCurrent(target)).toThrow("Session event owner is being deleted");
        for (const expectedTarget of [target, undefined]) {
          const receipt = enqueueCompletion(expectedTarget);
          await expectStopped(receipt, "failed", "Session event agent is being deleted");
        }
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        await deletion.rollback();
      },
      { env },
    );
    expect(() => assertTargetCurrent(target)).not.toThrow();
  });

  it("captures cold events across an empty usage refresh", async ({ coldState: { env } }) => {
    const { refreshCostUsageCacheForAgent } =
      await import("../../infra/session-cost-usage-aggregation.js");
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    using reader = interceptReadOwner(async (owner) => {
      expect(owner.source).toBeUndefined();
      await expect(refreshCostUsageCacheForAgent({ agentId: "main", env })).resolves.toBe(
        "refreshed",
      );
      return owner;
    });
    const target = await captureTarget("main", sessionKey, { env });
    expect(target.sessionId).toBe("");
    reader.mockRestore();
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    const prepared = await prepareTarget(target, { createIfMissing: true });
    using held = { [Symbol.dispose]: () => prepared.release() };
    void held;
    prepared.assertCurrent();
    expect((await fs.stat(databasePath)).isFile()).toBe(true);
    const next = await prepareTarget(target, { createIfMissing: true });
    next.release();
    prepared.assertCurrent();
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
    using platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    void platform;
    // Windows short directory aliases aren't symlinks; the fixture shares real DB/WAL files.
    using lstat = vi
      .spyOn(fsSync, "lstatSync")
      .mockImplementation((pathname, options) =>
        originalLstat(String(pathname) === directory ? canonicalDirectory : pathname, options),
      );
    void lstat;
    using reader = interceptReadOwner((owner) => ({
      ...owner,
      // Transfer the historical spelling but preserve native facts and guards.
      selectedStore: owner.selectedStore && { ...owner.selectedStore, physicalPath: storePath },
    }));
    const target = await captureTarget("main", sessionKey, { env: state.env });
    reader.mockRestore();
    const prepared = await prepareTarget(target, { createIfMissing: true });
    using held = { [Symbol.dispose]: () => prepared.release() };
    void held;
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
  });

  it.for([false, true])(
    "joins cold preparation before cancellation (retained: %s)",
    async (preserve, { signal, coldState: { env } }) => {
      const target = await captureTarget("main", sessionKey, { env });
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
      const receipt = enqueueEvent("Cancelled fresh ingress", {
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

  it.for(["retained", "revoked", "already-revoked"] as const)(
    "does not prepare cold storage for %s work",
    async (kind, { emptyState: { env } }) => {
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const target = await captureTarget("main", sessionKey, { env });
      expect(target.sessionId).toBe("");
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      let current = kind !== "already-revoked";
      const enqueue = () =>
        enqueueEvent("Fresh ingress", {
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
      } else {
        const receipt = enqueue();
        current &&= kind !== "revoked";
        const error = kind === "retained" ? /origin is missing/ : /ingress was revoked/;
        await expect(receipt.accepted).resolves.toMatchObject({
          ok: false,
          error: expect.stringMatching(error),
        });
        await expectStopped(receipt, "failed");
      }
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.for(["plugin", "tool_handoff"] as const)(
    "refuses a keyed %s retry while its occurrence is pending",
    async (source, { state: { env } }) => {
      const target = await captureTarget("main", sessionKey, { env });
      const contextKey = "tool-handoff:retry";
      const pending = enqueueRequiredSystemEventEntry("Tool result", {
        sessionKey,
        contextKey,
        deliveryContext: target.deliveryContext,
      });
      expect(() =>
        enqueueEvent("Tool result", { ...eventScope, source, contextKey, expectedTarget: target }),
      ).toThrow("an identical occurrence is already pending");
      expect(peekSystemEventEntries(sessionKey)).toEqual([pending]);
    },
  );

  it("does not batch an owner's completion with another requester's", async ({
    state: { env },
  }) => {
    setRuntimeConfigSnapshot({
      agents: { entries: { main: {} } },
      channels: { telegram: {} },
      commands: { ownerAllowFrom: ["456"] },
    });
    const capture = (senderId: string) =>
      withGatewayToolCallerIdentity(
        {
          ...eventScope,
          requesterOrigin: { sessionKey, messageProvider: "telegram", senderId },
        },
        () => captureTarget("main", sessionKey, { env, retainRequesterOwner: true }),
      );
    const owner = await capture("456");
    const guest = await capture("789");
    expect(() => combineSessionEventTargetsForHost([owner, guest])).toThrow(
      "different captured destinations or requester authority",
    );
    expect(combineSessionEventTargetsForHost([owner, await capture("456")])).toBeDefined();
  });

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
        captureTarget("main", sessionKey, {
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
    expect(() => assertTargetCurrent(target)).not.toThrow();
    producerActive = false;
    expect(() => assertTargetCurrent(target)).toThrow("Background producer retired");
    expect(() => enqueueCompletion(target)).toThrow("Background producer retired");
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it.for(["invocation", "producer", "queued producer"] as const)(
    "rejects %s retirement",
    async (owner, { state: { env } }) => {
      let active = true;
      const capture = withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, receiptAuthority: () => owner !== "invocation" || active },
        () =>
          captureTarget("main", sessionKey, {
            env,
            assertCurrent: () => {
              if (owner !== "invocation" && !active) {
                throw new Error("Background producer retired");
              }
            },
          }),
      );
      if (owner === "queued producer") {
        const receipt = enqueueCompletion(await capture);
        active = false;
        await expectStopped(receipt, "failed", "Background producer retired");
        await joinContinuations();
        expect(receipt.cancel()).toBe(false);
      } else {
        active = false;
        await expect(capture).rejects.toThrow(
          owner === "invocation" ? "no longer owns its invocation" : "Background producer retired",
        );
      }
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    },
  );

  it.for(["session reset", "lifecycle replacement"] as const)(
    "rejects %s before dispatch",
    async (change, { state: { env, storePath } }) => {
      const target = await captureTarget("main", sessionKey, { env });
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

  it("cancels pending occurrences when queues close", async ({ state: { env } }) => {
    const target = await captureTarget("main", sessionKey, { env });
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
    } finally {
      suspension?.release();
    }
  });

  it.for(["reject", "cancel", "removed"] as const)(
    "preserves passive occurrences after %s settlement",
    async (boundary, { state: { env } }) => {
      const target = await captureTarget("main", sessionKey, { env });
      const occurrence = enqueueRequiredSystemEventEntry("Deferred hook", { sessionKey });
      if (!occurrence) {
        throw new Error("Expected deferred hook occurrence");
      }
      if (boundary === "reject") {
        gatewayWork.markGatewayRestartDraining();
      }
      const receipt = enqueueEvent(occurrence.text, {
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
      await expectStopped(receipt, boundary === "reject" ? "failed" : "cancelled");
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
  const target = await captureTarget("main", sessionKey, {
    env,
    operatorAuthority: guest,
  });
  const other = await captureTarget("main", sessionKey, {
    env,
    operatorAuthority: admin,
  });
  expect(() => combineSessionEventTargetsForHost([target, other])).toThrow(
    "different captured destinations",
  );
  const receipt = enqueueCompletion(target);
  expect(receipt.cancel()).toBe(true);
  await expect(withinTest(receipt.settled, signal)).resolves.toMatchObject({
    status: "cancelled",
    executionStarted: false,
  });
  expect(retain).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});
