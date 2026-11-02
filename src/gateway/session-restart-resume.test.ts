import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureSessionQueuedInputsForRestart,
  listSessionPendingInputs,
  readSessionPendingInput,
} from "../config/sessions/session-pending-input-history.js";
import * as pendingInputWithdrawal from "../config/sessions/session-pending-input-withdrawal.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  publishPendingAgentDatabaseReadAdmission,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import {
  persistRunningSessionsForRestart,
  prepareAgentRestartRecovery,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

it("resumes orphaned lifecycle owners once through the marker path without adopting live or terminal work", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const cases: Array<[string, Partial<InternalSessionEntry>, boolean]> = [
      ["crash", {}, true],
      ["marked", { resumeAfterRestart: { queuedInputIds: [] } }, true],
      ["yielded", { endedAt: 2 }, true],
      ["completed", { status: "done" }, false],
      ["stopped", { status: "killed", abortedLastRun: true }, false],
      ["archived", { archivedAt: 2 }, false],
      ["external", { modelSelectionLocked: true }, false],
      ["cron:job", {}, false],
      ["subagent:child", {}, false],
      ["live", {}, false],
    ];
    for (const [name, patch] of cases) {
      const sessionKey = `agent:main:${name}`;
      replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId: name, updatedAt: 1 });
      await persistGatewaySessionLifecycleEvent({
        sessionKey,
        event: { runId: name, sessionId: name, ts: 1, data: { phase: "start", startedAt: 1 } },
      });
      const entry = loadExactSessionEntry({ agentId: "main", sessionKey })!.entry;
      expect(entry.lifecycleRunId).toBe(name);
      replaceSessionEntrySync({ agentId: "main", sessionKey }, { ...entry, ...patch });
    }
    const claim = claimAgentRunContext(
      "live",
      { agentId: "main", sessionKey: "agent:main:live", sessionId: "live" },
      { trackOwner: true, ownsContext: true },
    );
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    try {
      for (let boot = 0; boot < 2; boot++) {
        await resumeMarkedSessions({
          context: createContext(),
          signal: new AbortController().signal,
          log: { warn() {} },
        });
      }
      expect(resume.mock.calls.map(([, options]) => options.sessionKey).toSorted()).toEqual(
        cases
          .filter((row) => row[2])
          .map(([name]) => `agent:main:${name}`)
          .toSorted(),
      );
      expect(
        loadExactSessionEntry({ agentId: "main", sessionKey: "agent:main:live" })?.entry,
      ).toHaveProperty("lifecycleRunId", "live");
    } finally {
      resume.mockRestore();
      releaseAgentRunContext("live", claim);
    }
  }));

it("marks completed reply settlement only when accepted inputs remain queued", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionKey: "agent:main:completed-before-restart",
      sessionId: "completed-before-restart",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const runId = "completed-worker-reply";
    const { operation, releaseExecution } = await withSessionTurn(target, async (active) => {
      assert(active, "Expected a real reply operation");
      active.attachBackend({ kind: "embedded", runId, cancel() {} });
      active.freezeAbort();
      return { operation: active, releaseExecution: active.retainExecution() };
    });
    const runClaim = claimAgentRunContext(runId, target, { trackOwner: true, ownsContext: true });
    let queued: Awaited<ReturnType<typeof stageSessionPendingInput>> | undefined;
    try {
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();

      queued = await stageSessionPendingInput(target, {
        runId: "queued-behind-completed-reply",
        message: {
          role: "user",
          content: "Continue after the completed reply",
          timestamp: 2,
          idempotencyKey: "queued-behind-completed-reply:user",
        },
        assertCurrent() {},
      });
      assert(queued, "Queued fixture input was not admitted");
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({
        queuedInputIds: [queued.inputId],
      });
    } finally {
      queued?.finish("interrupted");
      await queued?.settled?.();
      releaseExecution();
      await operation.ownerSettlement;
      releaseAgentRunContext(runId, runClaim);
    }
  }));

it("marks ordinary conversations without inheriting cron or external execution ownership", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const cases: Array<{ sessionKey: string; resumable?: true; entry?: Partial<SessionEntry> }> = [
      { sessionKey: "agent:other:main", resumable: true },
      { sessionKey: "agent:other:main:thread:123.456", resumable: true },
      { sessionKey: "agent:main:cron:scheduled:run:occurrence" },
      { sessionKey: "agent:main:acp:external" },
      {
        sessionKey: "agent:main:external-acp-binding",
        entry: {
          acp: {
            backend: "fixture",
            agent: "main",
            runtimeSessionName: "external-runtime",
            mode: "persistent",
            state: "running",
            lastActivityAt: 1,
          },
        },
      },
      { sessionKey: "agent:main:external-harness", entry: { modelSelectionLocked: true } },
    ];
    try {
      for (const { sessionKey, entry, resumable } of cases) {
        const agentId = resumable ? "other" : "main";
        replaceSessionEntrySync(
          { agentId, sessionKey },
          { sessionId: sessionKey, updatedAt: 1, ...entry },
        );
        if (resumable) {
          subagentRuns.set(
            sessionKey,
            createSubagentRunRecord({
              runId: sessionKey,
              childSessionKey: sessionKey,
              childAgentId: agentId,
              requesterSessionKey: "agent:main:cron:scheduled:run:occurrence",
              endedAt: sessionKey.endsWith(":main") ? 1 : undefined,
            }),
          );
        }
        const process = createProcessSessionFixture({ id: sessionKey, backgrounded: true });
        process.agentId = agentId;
        process.sessionKey = sessionKey;
        addSession(process);
      }
      await persistRunningSessionsForRestart({ cfg: {} });
      for (const { sessionKey, resumable } of cases) {
        const entry = loadExactSessionEntry({
          agentId: resumable ? "other" : "main",
          sessionKey,
        })?.entry;
        expect(entry).toBeDefined();
        expect(entry?.resumeAfterRestart, sessionKey).toEqual(
          resumable ? { queuedInputIds: [], hadBackgroundExec: true } : undefined,
        );
      }
    } finally {
      for (const { sessionKey, resumable } of cases) {
        if (resumable) {
          subagentRuns.delete(sessionKey);
        }
      }
      resetProcessRegistryForTests();
    }
  }));

it("settles captured queued sends as failed when the recorded owner's authority is revoked", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
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
    setRuntimeConfigSnapshot(cfg);
    const profile = ensureProfileForEmail("queued-before-revocation@example.test");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:revoked-queued-owner",
      sessionId: "revoked-queued-owner",
    };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const receipt = await stageSessionPendingInput(target, {
      runId: "queued-before-revocation",
      message: {
        role: "user",
        content: "Accepted before restart",
        timestamp: 1,
        idempotencyKey: "queued-before-revocation:user",
        __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
      },
      assertCurrent() {},
    });
    assert(receipt, "Queued fixture input was not admitted");
    const process = createProcessSessionFixture({ id: "revoked-owner-work", backgrounded: true });
    process.agentId = target.agentId;
    process.sessionKey = target.sessionKey;
    addSession(process);
    try {
      await persistRunningSessionsForRestart({ cfg });
      receipt.finish("interrupted");
      await receipt.settled?.();
      setUserProfileRole(profile.id, "reader");
      const warn = vi.fn();
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped restart resume"));
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
      expect(await readSessionPendingInput(target, receipt.inputId)).toMatchObject({
        state: "cancelled",
        message: { content: "Accepted before restart" },
      });
    } finally {
      receipt?.finish("interrupted");
      await receipt?.settled?.();
      resetProcessRegistryForTests();
    }
  }));

it("fails a captured browser-copilot send instead of running without its live binding", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const profile = ensureGatewayOwnerProfile("Browser owner");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:bound-browser-queue",
      sessionId: "bound-browser-queue",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const receipt = await stageSessionPendingInput(target, {
      runId: "bound-browser-send",
      message: {
        role: "user",
        content: "Inspect the selected tab",
        timestamp: 1,
        idempotencyKey: "bound-browser-send:user",
        __openclaw: {
          senderIdentity: { type: "profile", id: profile.id },
          transport: {
            clients: [{ id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT, mode: GATEWAY_CLIENT_MODES.UI }],
          },
        },
      },
      assertCurrent() {},
    });
    assert(receipt, "Queued fixture input was not admitted");
    const send = vi.spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess").mockResolvedValue({});
    const context = createContext();
    try {
      const captured = await captureSessionQueuedInputsForRestart(target);
      captured.preserve();
      receipt.finish("interrupted");
      await receipt.settled?.();
      await continueSessionQueuedInputs(context, target, {
        signal: new AbortController().signal,
        queuedInputIds: [receipt.inputId],
        assertCurrent() {},
      });
      expect(send.mock.calls.length).toBe(0);
      expect(await readSessionPendingInput(target, receipt.inputId)).toMatchObject({
        state: "cancelled",
        message: { content: "Inspect the selected tab" },
      });
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        expect.stringContaining("Browser-bound queued input requires a fresh browser send"),
      );
    } finally {
      send.mockRestore();
      receipt.finish("cancelled");
      await receipt.settled?.();
    }
  }));

it("leaves a read-ready shared store to its pending preparation owner for restart recovery", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env, statePath }) => {
    const storePath = statePath("restart-shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, other: {} } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    const targets = ["main", "other"].map((agentId) => ({
      agentId,
      sessionKey: `agent:${agentId}:pending-restart`,
      sessionId: `${agentId}-pending-restart`,
      storePath,
    }));
    for (const target of targets) {
      replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
      const entry = loadExactSessionEntry(target)?.entry;
      assert(entry, "Restart fixture session was not created");
      replaceSessionEntrySync(target, {
        ...entry,
        resumeAfterRestart: { queuedInputIds: [] },
      });
    }
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [storePath],
      reason: "Shared store is inspected; writable preparation is still pending",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
    const revokeRead = publishPendingAgentDatabaseReadAdmission(refusal, {
      env,
      paths: [storePath],
      assertCurrent() {},
    });
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "pending-preparation-resume",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const params = {
      context: createContext([], () => cfg),
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
    };
    try {
      // Discovery must release the global input fence while this store is still pending.
      await resumeMarkedSessions(params);
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBe(refusal);
      expect(resume).not.toHaveBeenCalled();
      for (const target of targets) {
        expect((await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart).toEqual({
          queuedInputIds: [],
        });
      }
      let recover: Awaited<ReturnType<typeof prepareAgentRestartRecovery>>;
      await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
        recover = await prepareAgentRestartRecovery({
          ...params,
          agentId: "main",
          env,
          assertCurrent() {},
        });
      });
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
      assert(recover, "Preparation did not retain the shared store's restart recovery");
      await recover();
      expect(resume.mock.calls.map(([, options]) => options.sessionKey).toSorted()).toEqual(
        targets.map(({ sessionKey }) => sessionKey).toSorted(),
      );
      for (const target of targets) {
        expect(
          (await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart,
        ).toBeUndefined();
      }
      await resumeMarkedSessions(params);
      expect(resume).toHaveBeenCalledTimes(2);
      expect(params.log.warn).not.toHaveBeenCalled();
    } finally {
      revokeRead();
      recordAgentDatabaseAdmissions([], { env, source: "startup" });
      resume.mockRestore();
    }
  }));

it("resumes recent interrupted legacy cycles once and settles crash inputs", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = { agentId: "main", sessionKey: "agent:main:crashed", sessionId: "crashed" };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    for (const [name, hoursAgo, status, abortedLastRun, tombstone] of [
      ["legacy", 1, "interrupted", true, undefined],
      ["stale", 7, "interrupted", true, undefined],
      ["done", 1, "done", true, undefined],
      ["killed", 1, "killed", true, undefined],
      ["future", -1, "interrupted", true, undefined],
      ["settled", 1, "interrupted", false, undefined],
      ["retired", 1, "interrupted", true, { reason: "stopped" }],
    ] as const) {
      const entry = {
        sessionId: name,
        updatedAt: Math.floor(performance.timeOrigin) - hoursAgo * 60 * 60 * 1000,
        status,
        abortedLastRun,
        mainRestartRecovery: { cycleId: name, revision: 1, chargedAttempts: 0, tombstone },
      };
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES (?, ?, ?, ?, 1)",
        )
        .run(`agent:main:${name}`, name, JSON.stringify(entry), entry.updatedAt);
    }
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "upgrade-resume",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const discover = vi.spyOn(pendingInputWithdrawal, "listOrphanedSessionPendingInputTargets");
    const receipts = [];
    for (const runId of ["crashed", "live"]) {
      const receipt = await stageSessionPendingInput(target, {
        runId,
        assertCurrent() {},
        message: { role: "user", content: runId, timestamp: 1, idempotencyKey: `${runId}:user` },
      });
      assert(receipt, "Expected accepted input");
      receipts.push(receipt);
    }
    const [crashed, live] = receipts;
    const dispatch = vi.spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess");
    try {
      crashed!.finish("interrupted");
      await crashed!.settled?.();
      database.db
        .prepare(
          "UPDATE session_pending_inputs SET state = 'queued', lifecycle_generation = 'previous-process' WHERE input_id = ?",
        )
        .run(crashed!.inputId);
      const warn = vi.fn();
      for (let boot = 0; boot < 2; boot++) {
        await resumeMarkedSessions({
          context: createContext(),
          signal: new AbortController().signal,
          log: { warn },
        });
        expect(discover).toHaveBeenCalledTimes(boot + 1);
        expect((await listSessionPendingInputs(target)).items).toMatchObject([
          { runId: "crashed", state: "cancelled", message: { content: "crashed" } },
          { runId: "live", state: "queued" },
        ]);
      }
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
        "agent:main:legacy",
      ]);
      expect(resume.mock.calls[0]?.[0]).toContain("The Gateway restarted while you were working.");
      for (const name of ["legacy", "stale", "done", "killed", "future", "settled"]) {
        const persisted = database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(`agent:main:${name}`);
        expect(JSON.parse(String(persisted?.entry_json))).not.toHaveProperty("mainRestartRecovery");
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      resume.mockRestore();
      discover.mockRestore();
      dispatch.mockRestore();
      live!.finish("cancelled");
      await live!.settled?.();
    }
  }));
