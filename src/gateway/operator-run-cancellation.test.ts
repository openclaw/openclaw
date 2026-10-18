import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnEntry,
} from "./chat-queued-turns.js";
import { retainGatewayOperatorRun } from "./operator-run-cancellation.js";
import { createChatRunState } from "./server-chat-state.js";
import { createChatSendWorkAdmission } from "./server-methods/chat-send-work-admission.js";

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
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    chatQueuedTurns: new Map<string, QueuedChatTurnEntry>(),
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
  const register = (
    runId: string,
    buffer?: string,
    projection: Pick<
      Parameters<typeof registerChatAbortController>[0],
      "controlUiVisible" | "projectSessionActive"
    > = {},
  ) => {
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      ...scope,
      runId,
      timeoutMs: 60_000,
      ownerConnId: "same-person-connection",
      ...projection,
    });
    if (!registration.registered) {
      throw new Error("fixture run was not registered");
    }
    registrations.push(registration);
    if (buffer !== undefined) {
      chatRunState.getOrCreate(runId).buffer = buffer;
    }
    return {
      ...registration,
      retain: () => retain(runId, registration.entry),
      expectCurrent: () => {
        expect(registration.controller.signal.aborted).toBe(false);
        expect(context.chatAbortControllers.get(runId)).toBe(registration.entry);
      },
    };
  };
  const retain = async (runId: string, entry: ChatAbortControllerEntry) => {
    const { signal } = source;
    const retained = await retainGatewayOperatorRun({
      context,
      runId,
      entry,
      client: {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "test", version: "test", platform: "test", mode: "test" },
          role: "operator",
          scopes: ["operator.sessions.write"],
        },
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
    release: () => releases.forEach((release) => release()),
    cleanup: () => {
      registrations.forEach((registration) => registration.cleanup());
      for (const [runId, entry] of context.chatQueuedTurns) {
        completeQueuedChatTurn(context.chatQueuedTurns, runId, entry.controller);
      }
      chatRunState.clear();
      warn.mockRestore();
    },
  };
}

describe("operator access cancellation", () => {
  it.each([false, true])(
    "stops only its run and settles persistence (hidden progress refresh: %s)",
    (hiddenRefresh) =>
      withCancellationFixture(async (f) => {
        const guest = f.register(
          "guest-run",
          "The guest's saved progress.",
          hiddenRefresh ? { controlUiVisible: false, projectSessionActive: false } : {},
        );
        const staff = f.register("staff-run", "Staff work continues.");
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
          guest.entry.projectSessionTerminalObservedAt = Date.now();
          guest.entry.projectSessionTerminalPersistence = terminalWrite.promise.then(() => {
            guest.entry.projectSessionTerminalPending = false;
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
          expect(guest.entry.abortDiagnosticReason).toBe("authority-revoked");
          expect(staff.controller.signal.aborted).toBe(false);
          terminalWrite.resolve();
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
          unsubscribe();
          await drain;
        }
      }),
  );

  it.each(["persisting", "persisted"] as const)(
    "preserves an accepted terminal result while %s",
    (phase) =>
      withCancellationFixture(async (f) => {
        const guest = f.register("terminal-run", "The already accepted result.");
        const savedTranscript = f.transcript();
        const acceptedMessage = {
          role: "assistant",
          content: [{ type: "text", text: "The already accepted result." }],
        };
        const terminalWrite = createDeferredCore();
        guest.entry.projectSessionActive = false;
        guest.entry.projectSessionTerminalPending = true;
        guest.entry.projectSessionTerminalObservedAt = Date.now();
        const persistence = terminalWrite.promise.then(() => {
          expect(
            appendTranscriptMessageSync(f.scope, {
              eventId: "accepted-result",
              message: acceptedMessage,
            }),
          ).toMatchObject({ ok: true });
          guest.entry.projectSessionTerminalPending = false;
          guest.entry.projectSessionTerminalPersistence = undefined;
          guest.entry.projectSessionTerminalPersisted = true;
        });
        guest.entry.projectSessionTerminalPersistence = persistence;
        (await guest.retain()).armCancellation();
        try {
          if (phase === "persisted") {
            terminalWrite.resolve();
            await persistence;
          }
          await f.abort();
          guest.expectCurrent();
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
      }),
  );

  it.each([
    { collect: false, activeAdmission: false },
    { collect: true, activeAdmission: true },
  ])(
    "retains queued custody across collect=$collect and active admission=$activeAdmission",
    ({ collect, activeAdmission }) =>
      withCancellationFixture(async (f) => {
        const guest = f.register("queued-guest");
        const staff = f.register("queued-staff");
        const retained = await guest.retain();
        const work = createChatSendWorkAdmission({
          admission: { release: () => {} },
          releaseCallerAuthority: retained.release,
          logGateway: f.context.logGateway,
        });
        const releaseQueue = work.retain();
        const onGuestAborted = vi.fn();
        for (const [runId, registration] of [
          ["queued-guest", guest],
          ["queued-staff", staff],
        ] as const) {
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: f.context.chatQueuedTurns,
              ...f.scope,
              runId,
              controller: registration.controller,
              ...(runId === "queued-guest" ? { onAborted: onGuestAborted } : {}),
            }),
          ).toBe(true);
          if (!activeAdmission) {
            registration.cleanup();
          }
        }
        retained.armCancellation();
        work.release();
        if (collect) {
          retireQueuedChatTurnCancellation(
            f.context.chatQueuedTurns,
            "queued-guest",
            guest.controller,
          );
        }
        try {
          await f.abort();
          expect(guest.controller.signal.aborted).toBe(!collect);
          expect(onGuestAborted.mock.calls).toEqual(collect ? [] : [["authority-revoked"]]);
          expect(f.context.chatQueuedTurns.has("queued-guest")).toBe(collect);
          expect(staff.controller.signal.aborted).toBe(false);
          expect(f.context.chatQueuedTurns.has("queued-staff")).toBe(true);
          expect(f.context.chatAbortControllers.get("queued-guest")).toBe(
            activeAdmission ? guest.entry : undefined,
          );
          expect(f.context.broadcast).not.toHaveBeenCalled();
        } finally {
          releaseQueue();
        }
      }),
  );

  it.each(["before", "after"] as const)(
    "preserves replacement runs and accepted persistence when cleanup occurs %s revocation",
    (cleanup) =>
      withCancellationFixture(async (f) => {
        const original = f.register("reused-run", "Keep the canceled run's progress.");
        const retained = await original.retain();
        retained.armCancellation();
        if (cleanup === "after") {
          f.source.abort();
        }
        original.cleanup();
        if (cleanup === "after") {
          retained.release();
        }
        const replacement = f.register("reused-run");
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
      }),
  );

  it.each(["released", "already-aborted"] as const)(
    "leaves its run untouched after source release or rejected admission (%s)",
    (state) =>
      withCancellationFixture(async (f) => {
        const guest = f.register("bound-run");
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
      }),
  );

  it.each([false, true])(
    "leaves input custody untouched until execution owns cancellation (retired: %s)",
    (retired) =>
      withCancellationFixture(async (f) => {
        const guest = f.register("admitted-input");
        const staff = f.register("independent-backing-run");
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

        retained.armCancellation();
        await f.settle();
        expect(guest.controller.signal.aborted).toBe(!retired);
        staff.expectCurrent();
      }),
  );

  it.each(["reset", "retired"] as const)(
    "stops the exact run when partial capture meets a %s session",
    (change) =>
      withCancellationFixture(async (f) => {
        const guest = f.register("stale-session", "Progress from the previous session lifecycle.");
        if (change === "retired") {
          guest.entry.sessionId = "retired-session";
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
        await f.abort();
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
      }),
  );
});
