import { describe, expect, it, vi } from "vitest";
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
    cancelRunBoundApprovals: vi.fn(() => 0),
    getRuntimeConfig: () => cfg,
    trackExecution: (work) => execution.track(work),
    logGateway,
  };
  const registrations: Array<ReturnType<typeof registerChatAbortController>> = [];
  const releases: Array<() => void> = [];
  const register = (
    runId: string,
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
    return registration;
  };
  const retain = (signal: AbortSignal, runId: string, entry: ChatAbortControllerEntry) => {
    const retained = retainGatewayOperatorRun({
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
        internal: { operatorRoleActor: { kind: "operator", profileId: "guest-profile" } },
      },
      sourceAuthority: { signal, assertCurrent: () => signal.throwIfAborted() },
    });
    if (!retained.authority) {
      throw new Error("fixture operator source was not retained");
    }
    releases.push(retained.release);
    return retained;
  };
  return {
    scope,
    context,
    execution,
    settle: () =>
      AsyncWorkScope.runWhenAllIdle(
        () => [execution],
        () => {},
      ),
    warn,
    register,
    retain,
    release: () => {
      for (const release of releases) {
        release();
      }
    },
    cleanup: () => {
      for (const registration of registrations) {
        registration.cleanup();
      }
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
    async (hiddenRefresh) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register(
          "guest-run",
          hiddenRefresh ? { controlUiVisible: false, projectSessionActive: false } : {},
        );
        const staff = f.register("staff-run");
        const savedTranscript = loadTranscriptEventsSync(f.scope);
        f.context.chatRunState.getOrCreate("guest-run").buffer = "The guest's saved progress.";
        f.context.chatRunState.getOrCreate("staff-run").buffer = "Staff work continues.";
        f.retain(source.signal, "guest-run", guest.entry).armCancellation();
        const terminalWrite = createDeferredCore();
        const cancellationObserved = createDeferredCore();
        let sourceClosedAtAbort = false;
        const unsubscribe = onAgentEvent((event) => {
          if (event.runId !== "guest-run" || event.stream !== "lifecycle") {
            return;
          }
          sourceClosedAtAbort = source.signal.aborted;
          guest.entry.projectSessionTerminalObservedAt = Date.now();
          guest.entry.projectSessionTerminalPersistence = terminalWrite.promise.then(() => {
            guest.entry.projectSessionTerminalPending = false;
          });
          cancellationObserved.resolve();
        });
        let drain: Promise<void> | undefined;
        try {
          source.abort();
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
          expect(staff.controller.signal.aborted).toBe(false);
          terminalWrite.resolve();
          await drain;
          expect(f.context.chatRunState.resolveBuffer("staff-run").text).toBe(
            "Staff work continues.",
          );
          if (hiddenRefresh) {
            expect(loadTranscriptEventsSync(f.scope)).toEqual(savedTranscript);
            expect(f.context.broadcast).not.toHaveBeenCalled();
            expect(f.context.nodeSendToSession).not.toHaveBeenCalled();
          } else {
            expect(loadTranscriptEventsSync(f.scope)).toEqual(
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
      });
    },
  );

  it.each(["persisting", "persisted"] as const)(
    "preserves an accepted terminal result while %s",
    async (phase) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register("terminal-run");
        const savedTranscript = loadTranscriptEventsSync(f.scope);
        const acceptedMessage = {
          role: "assistant",
          content: [{ type: "text", text: "The already accepted result." }],
        };
        f.context.chatRunState.getOrCreate("terminal-run").buffer = "The already accepted result.";
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
        f.retain(source.signal, "terminal-run", guest.entry).armCancellation();
        try {
          if (phase === "persisted") {
            terminalWrite.resolve();
            await persistence;
          }
          source.abort();
          await f.settle();
          expect(guest.controller.signal.aborted).toBe(false);
          expect(f.context.chatAbortControllers.get("terminal-run")).toBe(guest.entry);
          expect(f.context.chatRunState.resolveBuffer("terminal-run").text).toBe(
            "The already accepted result.",
          );
          expect(f.context.broadcast).not.toHaveBeenCalled();
          terminalWrite.resolve();
          await persistence;
          expect(loadTranscriptEventsSync(f.scope)).toEqual([
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

  it.each(
    [false, true].flatMap((collect) =>
      [false, true].map((activeAdmission) => ({ collect, activeAdmission })),
    ),
  )(
    "retains queued custody across collect=$collect and active admission=$activeAdmission",
    async ({ collect, activeAdmission }) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register("queued-guest");
        const staff = f.register("queued-staff");
        const retained = f.retain(source.signal, "queued-guest", guest.entry);
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
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: f.context.chatQueuedTurns,
              ...f.scope,
              runId,
              controller: registration.controller,
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
          source.abort();
          await f.settle();
          expect(guest.controller.signal.aborted).toBe(!collect);
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
      });
    },
  );

  it("does not retire a replacement that reuses a completed run ID", async () => {
    await withCancellationFixture(async (f) => {
      const source = new AbortController();
      const original = f.register("reused-run");
      f.retain(source.signal, "reused-run", original.entry).armCancellation();
      original.cleanup();
      const replacement = f.register("reused-run");
      source.abort();
      await f.settle();
      expect(replacement.controller.signal.aborted).toBe(false);
      expect(f.context.chatAbortControllers.get("reused-run")).toBe(replacement.entry);
      expect(f.context.broadcast).not.toHaveBeenCalled();
    });
  });

  it.each(["released", "already-aborted"] as const)(
    "leaves its run untouched after source release or rejected admission (%s)",
    async (state) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register("bound-run");
        if (state === "already-aborted") {
          source.abort(new Error("operator source already ended"));
          expect(() => f.retain(source.signal, "bound-run", guest.entry)).toThrow(
            "operator source already ended",
          );
        } else {
          const retained = f.retain(source.signal, "bound-run", guest.entry);
          retained.armCancellation();
          retained.release();
          source.abort();
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
        const source = new AbortController();
        const guest = f.register("admitted-input");
        const staff = f.register("independent-backing-run");
        const retained = f.retain(source.signal, "admitted-input", guest.entry);
        const transcript = loadTranscriptEventsSync(f.scope);
        if (retired) {
          retained.armCancellation();
          retained.retireCancellation();
        }

        source.abort();
        await f.settle();
        expect(guest.controller.signal.aborted).toBe(false);
        expect(f.context.chatAbortControllers.get("admitted-input")).toBe(guest.entry);
        expect(f.context.broadcast).not.toHaveBeenCalled();
        expect(loadTranscriptEventsSync(f.scope)).toEqual(transcript);
        expect(() => retained.authority?.assertCurrent()).toThrow();

        retained.armCancellation();
        await f.settle();
        expect(guest.controller.signal.aborted).toBe(!retired);
        expect(staff.controller.signal.aborted).toBe(false);
        expect(f.context.chatAbortControllers.get("independent-backing-run")).toBe(staff.entry);
      });
    },
  );

  it("retains cancellation and partial persistence after immediate run cleanup releases its listener", async () => {
    await withCancellationFixture(async (f) => {
      const source = new AbortController();
      const guest = f.register("settled-run");
      f.context.chatRunState.getOrCreate("settled-run").buffer =
        "Keep the canceled run's progress.";
      const retained = f.retain(source.signal, "settled-run", guest.entry);
      retained.armCancellation();
      source.abort();
      guest.cleanup();
      retained.release();
      const replacement = f.register("settled-run");
      await f.settle();
      expect(guest.controller.signal.aborted).toBe(true);
      expect(replacement.controller.signal.aborted).toBe(false);
      expect(loadTranscriptEventsSync(f.scope)).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "Keep the canceled run's progress." }],
          }),
        }),
      );
    });
  });

  it("still stops its exact run if partial transcript capture fails", async () => {
    await withCancellationFixture(async (f) => {
      const source = new AbortController();
      const guest = f.register("failed-partial-capture");
      guest.entry.sessionId = "retired-session";
      f.context.chatRunState.getOrCreate("failed-partial-capture").buffer =
        "Preserve this progress.";
      f.retain(source.signal, "failed-partial-capture", guest.entry).armCancellation();
      source.abort();
      await f.settle();
      expect(guest.controller.signal.aborted).toBe(true);
      expect(f.warn).toHaveBeenCalledWith(
        expect.stringContaining("Aborted partial transcript session changed before persistence"),
      );
    });
  });
});
