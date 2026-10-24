import { describe, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  retireSessionControllerSourceCancellation,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import {
  isRpcSourceQueued,
  setRpcSourceProjectSessionActive,
  updateRpcSourceSessionId,
} from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { retainGatewayOperatorRun } from "./operator-run-cancellation.js";
import { createChatRunState } from "./server-chat-state.js";
import { createChatSendWorkAdmission } from "./server-methods/chat-send-work-admission.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

async function withCancellationFixture(
  run: (fixture: Awaited<ReturnType<typeof createCancellationFixture>>) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "operator-run-cancellation" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await createCancellationFixture(cfg);
    try {
      await run(fixture);
    } finally {
      fixture.release();
      await fixture.execution.drain();
      fixture.cleanup();
    }
  });
}

async function createCancellationFixture(cfg: OpenClawConfig) {
  const profile = ensureProfileForEmail("guest-cancellation@example.test");
  const source = new AbortController();
  const scope = {
    agentId: "main",
    sessionId: "guest-and-staff-session",
    sessionKey: "agent:main:guest-and-staff",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const savedInput = { role: "user", content: [{ type: "text", text: "Saved work stays here." }] };
  expect(
    appendTranscriptMessageSync(scope, { eventId: "saved-input", message: savedInput }),
  ).toMatchObject({ ok: true });
  const chatRunState = createChatRunState();
  const execution = new AsyncWorkScope();
  const logGateway = createSubsystemLogger("test/operator-run-cancellation");
  const warn = vi.spyOn(logGateway, "warn").mockImplementation(() => {});
  const context: Parameters<typeof retainGatewayOperatorRun>[0]["context"] = {
    chatRunState,
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    removeChatRun: (sessionId, runId, sessionKey) =>
      chatRunState.registry.remove(sessionId, runId, sessionKey),
    cancelRunBoundApprovals: vi.fn().mockResolvedValue(0),
    getRuntimeConfig: () => cfg,
    trackExecution: (work) => execution.track(work),
    logGateway,
  };
  const registrations: Array<ReturnType<typeof registerChatAbortController>> = [];
  const releases: Array<() => void> = [];
  const claimReleases = new Map<RpcSourceRef, () => void>();
  const finishClaim = async (entry: RpcSourceRef) => {
    const claim = entry.input.claim;
    claimReleases.get(entry)?.();
    await claim?.settlement.promise;
  };
  const register = async (
    runId: string,
    buffer?: string,
    projection: Pick<
      Parameters<typeof registerChatAbortController>[0],
      "controlUiVisible" | "projectSessionActive"
    > = {},
    queued = false,
    preparing = false,
  ) => {
    const registration = registerChatAbortController({
      ...scope,
      target: captureSessionTarget({
        storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
        incarnation: scope.sessionId,
      }),
      runId,
      timeoutMs: 60_000,
      ownerConnId: "same-person-connection",
      ...projection,
    });
    if (!registration.registered) {
      throw new Error("fixture run was not registered");
    }
    registrations.push(registration);
    if (!queued && !preparing) {
      const releaseClaim = await claimRpcSourceForTest(registration.entry);
      releases.push(releaseClaim);
      claimReleases.set(registration.entry, releaseClaim);
    }
    if (buffer !== undefined) {
      chatRunState.getOrCreate(runId).buffer = buffer;
    }
    return {
      ...registration,
      retain: () => retain(runId, registration.entry),
      expectCurrent: () => {
        expect(registration.controller.signal.aborted).toBe(false);
        expect(rpcSourceTesting.get(runId)).toBe(registration.entry);
      },
    };
  };
  const retain = async (runId: string, entry: RpcSourceRef) => {
    const { signal } = source;
    const retained = await retainGatewayOperatorRun({
      context,
      runId,
      entry,
      client: {
        connect: gatewayConnect(["operator.sessions.write"], {
          id: "test",
          mode: "test",
        }),
        internal: { operatorRoleActor: { kind: "operator", profileId: profile.id } },
      },
      sourceAuthority: { signal, assertCurrent: () => signal.throwIfAborted() },
    });
    if (!retained.authority) {
      throw new Error("fixture operator source was not retained");
    }
    releases.push(retained.release);
    return retained;
  };
  const settle = () =>
    AsyncWorkScope.runWhenAllIdle(
      () => [execution],
      () => {},
    );
  return {
    source,
    scope,
    context,
    execution,
    settle,
    abort: () => {
      source.abort();
      return settle();
    },
    transcript: () => loadTranscriptEventsSync(scope),
    warn,
    register,
    finishClaim,
    abortRun: async (entry: RpcSourceRef) => {
      const aborted = createDeferredCore();
      entry.input.abortSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
      source.abort();
      await aborted.promise;
      await finishClaim(entry);
      await settle();
    },
    release: () => {
      for (const release of releases) {
        release();
      }
    },
    cleanup: () => {
      for (const registration of registrations) {
        registration.cleanup();
      }
      for (const entry of rpcSourceTesting.values()) {
        retireSessionControllerInput(entry.input);
      }
      rpcSourceTesting.clear();
      chatRunState.clear();
      warn.mockRestore();
    },
  };
}

describe("operator access cancellation", () => {
  it.each([false, true])(
    "stops only its run and settles persistence (hidden progress refresh: %s)",
    async (hiddenRefresh) => {
      await withCancellationFixture(async (f) => {
        const guest = await f.register(
          "guest-run",
          "The guest's saved progress.",
          hiddenRefresh ? { controlUiVisible: false, projectSessionActive: false } : {},
        );
        const staff = await f.register("staff-run", "Staff work continues.", {}, false, true);
        const savedTranscript = f.transcript();
        (await guest.retain()).armCancellation();
        const terminalWrite = createDeferredCore();
        const cancellationObserved = createDeferredCore();
        let sourceClosedAtAbort = false;
        const unsubscribe = onAgentEvent((event) => {
          if (event.runId !== "guest-run" || event.stream !== "lifecycle") {
            return;
          }
          sourceClosedAtAbort = f.source.signal.aborted;
          guest.entry.adapter.projectSessionTerminalObservedAt = Date.now();
          guest.entry.adapter.projectSessionTerminalPersistence = terminalWrite.promise.then(() => {
            guest.entry.adapter.projectSessionTerminalPending = false;
          });
          cancellationObserved.resolve();
        });
        let drain: Promise<void> | undefined;
        try {
          f.source.abort();
          await Promise.race([
            cancellationObserved.promise,
            f.settle().then(() => {
              throw new Error("cancellation finished without aborting its registered run");
            }),
          ]);
          let drained = false;
          drain = f.settle().then(() => {
            drained = true;
          });
          await Promise.resolve();
          expect(drained).toBe(false);
          expect(sourceClosedAtAbort).toBe(true);
          expect(guest.controller.signal.aborted).toBe(true);
          expect(guest.entry.adapter.abortDiagnosticReason).toBe("authority-revoked");
          expect(staff.controller.signal.aborted).toBe(false);
          terminalWrite.resolve();
          await Promise.resolve();
          expect(drained).toBe(false);
          await f.finishClaim(guest.entry);
          await drain;
          expect(f.context.chatRunState.resolveBuffer("staff-run").text).toBe(
            "Staff work continues.",
          );
          if (hiddenRefresh) {
            expect(f.transcript()).toEqual(savedTranscript);
            expect(f.context.broadcast).not.toHaveBeenCalled();
            expect(f.context.nodeSendToSession).not.toHaveBeenCalled();
          } else {
            expect(f.transcript()).toEqual(
              expect.arrayContaining([
                ...savedTranscript,
                expect.objectContaining({
                  message: expect.objectContaining({
                    role: "assistant",
                    content: [{ type: "text", text: "The guest's saved progress." }],
                  }),
                }),
              ]),
            );
          }
          expect(f.warn).not.toHaveBeenCalled();
        } finally {
          terminalWrite.resolve();
          await f.finishClaim(guest.entry);
          unsubscribe();
          await drain;
        }
      });
    },
  );

  it.each(["persisting", "persisted"] as const)(
    "preserves an accepted terminal result while %s",
    async (phase) => {
      await withCancellationFixture(async (f) => {
        const guest = await f.register("terminal-run", "The already accepted result.");
        const savedTranscript = f.transcript();
        const acceptedMessage = {
          role: "assistant",
          content: [{ type: "text", text: "The already accepted result." }],
        };
        const terminalWrite = createDeferredCore();
        setRpcSourceProjectSessionActive(guest.entry, false);
        guest.entry.adapter.projectSessionTerminalPending = true;
        guest.entry.adapter.projectSessionTerminalObservedAt = Date.now();
        const persistence = terminalWrite.promise.then(() => {
          expect(
            appendTranscriptMessageSync(f.scope, {
              eventId: "accepted-result",
              message: acceptedMessage,
            }),
          ).toMatchObject({ ok: true });
          guest.entry.adapter.projectSessionTerminalPending = false;
          guest.entry.adapter.projectSessionTerminalPersistence = undefined;
          guest.entry.adapter.projectSessionTerminalPersisted = true;
        });
        guest.entry.adapter.projectSessionTerminalPersistence = persistence;
        (await guest.retain()).armCancellation();
        try {
          if (phase === "persisted") {
            terminalWrite.resolve();
            await persistence;
          }
          await f.abort();
          guest.expectCurrent();
          expect(guest.entry.input.claim?.released).toBe(false);
          expect(f.context.chatRunState.resolveBuffer("terminal-run").text).toBe(
            "The already accepted result.",
          );
          expect(f.context.broadcast).not.toHaveBeenCalled();
          terminalWrite.resolve();
          await persistence;
          expect(f.transcript()).toEqual([
            ...savedTranscript,
            expect.objectContaining({
              id: "accepted-result",
              message: expect.objectContaining(acceptedMessage),
            }),
          ]);
          expect(f.warn).not.toHaveBeenCalled();
        } finally {
          terminalWrite.resolve();
          await persistence;
        }
      });
    },
  );

  it.each([
    { collect: false, activeAdmission: false },
    { collect: true, activeAdmission: true },
  ])(
    "retains queued custody across collect=$collect and active admission=$activeAdmission",
    async ({ collect, activeAdmission }) => {
      await withCancellationFixture(async (f) => {
        const guest = await f.register("queued-guest", undefined, {}, true);
        const staff = await f.register("queued-staff", undefined, {}, true);
        const retained = await guest.retain();
        const work = createChatSendWorkAdmission({
          admission: { release: () => {} },
          releaseCallerAuthority: retained.release,
          logGateway: f.context.logGateway,
        });
        const releaseQueue = work.retain();
        for (const [runId, registration] of [
          ["queued-guest", guest],
          ["queued-staff", staff],
        ] as const) {
          const run = createQueueTestRun({ prompt: runId });
          run.run = { ...run.run, config: f.context.getRuntimeConfig(), ...f.scope };
          run.abortSignal = registration.entry.input.abortSignal;
          bindSessionControllerSource(registration.entry.input, run);
          enqueueFollowupRun(f.scope.sessionKey, run, { mode: "followup" }, "none");
          expect(isRpcSourceQueued(registration.entry)).toBe(true);
          if (!activeAdmission) {
            registration.cleanup();
          }
        }
        retained.armCancellation();
        work.release();
        if (collect) {
          retireSessionControllerSourceCancellation(guest.entry.input);
        }
        try {
          await f.abort();
          expect(guest.controller.signal.aborted).toBe(!collect);
          expect(guest.entry.adapter.abortDiagnosticReason).toBe(
            collect ? undefined : "authority-revoked",
          );
          expect(isRpcSourceQueued(guest.entry)).toBe(false);
          expect(staff.controller.signal.aborted).toBe(false);
          expect(rpcSourceTesting.has("queued-staff")).toBe(true);
          expect(rpcSourceTesting.get("queued-guest")).toBe(
            collect || activeAdmission ? guest.entry : undefined,
          );
          expect(f.context.broadcast).not.toHaveBeenCalled();
        } finally {
          releaseQueue();
        }
      });
    },
  );

  it.each(["before", "after"] as const)(
    "preserves replacement runs and accepted persistence when cleanup occurs %s revocation",
    async (cleanup) => {
      await withCancellationFixture(async (f) => {
        const original = await f.register("reused-run", "Keep the canceled run's progress.");
        const retained = await original.retain();
        retained.armCancellation();
        if (cleanup === "after") {
          f.source.abort();
        }
        await f.finishClaim(original.entry);
        original.cleanup();
        if (cleanup === "after") {
          retained.release();
        }
        const replacement = await f.register("reused-run");
        if (cleanup === "before") {
          f.source.abort();
        }
        await f.settle();
        replacement.expectCurrent();
        if (cleanup === "before") {
          expect(f.context.broadcast).not.toHaveBeenCalled();
        } else {
          expect(original.controller.signal.aborted).toBe(true);
          expect(f.transcript()).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({
                content: [{ type: "text", text: "Keep the canceled run's progress." }],
              }),
            }),
          );
        }
      });
    },
  );

  it.each(["released", "already-aborted"] as const)(
    "leaves its run untouched after source release or rejected admission (%s)",
    async (state) => {
      await withCancellationFixture(async (f) => {
        const guest = await f.register("bound-run");
        if (state === "already-aborted") {
          f.source.abort(new Error("operator source already ended"));
          await expect(guest.retain()).rejects.toThrow("operator source already ended");
        } else {
          const retained = await guest.retain();
          retained.armCancellation();
          retained.release();
          f.source.abort();
        }
        await f.settle();
        expect(guest.controller.signal.aborted).toBe(false);
      });
    },
  );

  it.each([false, true])(
    "leaves input custody untouched until execution owns cancellation (retired: %s)",
    async (retired) => {
      await withCancellationFixture(async (f) => {
        const guest = await f.register("admitted-input");
        const staff = await f.register("independent-backing-run", undefined, {}, false, true);
        const retained = await guest.retain();
        const transcript = f.transcript();
        if (retired) {
          retained.armCancellation();
          retained.retireCancellation();
        }

        await f.abort();
        guest.expectCurrent();
        expect(f.context.broadcast).not.toHaveBeenCalled();
        expect(f.transcript()).toEqual(transcript);
        expect(() => retained.authority?.assertCurrent()).toThrow();

        const aborted = createDeferredCore();
        guest.controller.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        retained.armCancellation();
        if (!retired) {
          await aborted.promise;
          await f.finishClaim(guest.entry);
        }
        await f.settle();
        expect(guest.controller.signal.aborted).toBe(!retired);
        staff.expectCurrent();
      });
    },
  );

  it.each(["reset", "retired"] as const)(
    "stops the exact run when partial capture meets a %s session",
    async (change) => {
      await withCancellationFixture(async (f) => {
        const guest = await f.register(
          "stale-session",
          "Progress from the previous session lifecycle.",
        );
        if (change === "retired") {
          updateRpcSourceSessionId(guest.entry, "retired-session");
        }
        (await guest.retain()).armCancellation();
        if (change === "reset") {
          await replaceSessionEntry(f.scope, {
            sessionId: f.scope.sessionId,
            updatedAt: 2,
            lifecycleRevision: "reset-lifecycle",
          });
        }
        const transcript = change === "reset" ? f.transcript() : undefined;
        await f.abortRun(guest.entry);
        expect(guest.controller.signal.aborted).toBe(true);
        if (change === "reset") {
          expect(f.transcript()).toEqual(transcript);
          expect(f.warn).toHaveBeenCalled();
        } else {
          expect(f.warn).toHaveBeenCalledWith(
            expect.stringContaining(
              "Aborted partial transcript session changed before persistence",
            ),
          );
        }
      });
    },
  );

  it("does not treat a retargeted source as authority to write after session replacement", async () => {
    await withCancellationFixture(async (f) => {
      const guest = await f.register("rotated-partial-capture");
      const retained = await guest.retain();
      retained.armCancellation();
      const originalTranscript = f.transcript();
      const rotatedScope = { ...f.scope, sessionId: "rotated-session" };
      await replaceSessionEntry(f.scope, { sessionId: rotatedScope.sessionId, updatedAt: 2 });
      const rotatedTranscript = loadTranscriptEventsSync(rotatedScope);
      updateRpcSourceSessionId(guest.entry, rotatedScope.sessionId);
      f.context.chatRunState.getOrCreate("rotated-partial-capture").buffer =
        "Preserve this progress.";
      await f.abortRun(guest.entry);
      expect(guest.controller.signal.aborted).toBe(true);
      expect(f.transcript()).toEqual(originalTranscript);
      expect(loadTranscriptEventsSync(rotatedScope)).toEqual(rotatedTranscript);
      expect(f.warn).toHaveBeenCalledWith(
        expect.stringContaining("Aborted partial transcript session changed before persistence"),
      );
    });
  });
});
