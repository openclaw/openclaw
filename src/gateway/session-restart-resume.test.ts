import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureSessionQueuedInputsForRestart,
  listSessionPendingInputs,
  readSessionPendingInput,
} from "../config/sessions/session-pending-input-history.js";
import * as pendingInputWithdrawal from "../config/sessions/session-pending-input-withdrawal.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

it("marks completed reply settlement only when accepted inputs remain queued", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionKey: "agent:main:completed-before-restart",
      sessionId: "completed-before-restart",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
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

it("leaves running cron and external-harness sessions with their execution owner", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const cases: Array<{ sessionKey: string; entry?: Partial<SessionEntry> }> = [
      { sessionKey: "agent:main:ordinary-running" },
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
      for (const { sessionKey, entry } of cases) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { sessionId: sessionKey, updatedAt: 1, ...entry },
        );
        const process = createProcessSessionFixture({ id: sessionKey, backgrounded: true });
        process.agentId = "main";
        process.sessionKey = sessionKey;
        process.scopeKey = sessionKey;
        addSession(process);
      }
      await persistRunningSessionsForRestart({ cfg: {} });
      for (const { sessionKey } of cases) {
        const entry = loadExactSessionEntry({ agentId: "main", sessionKey })?.entry;
        expect(entry).toBeDefined();
        expect(entry?.resumeAfterRestart, sessionKey).toEqual(
          sessionKey === "agent:main:ordinary-running"
            ? { queuedInputIds: [], hadBackgroundExec: true }
            : undefined,
        );
      }
    } finally {
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
