import { assert, describe, expect, it, vi } from "vitest";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  readSessionSubmittedInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import { withRecovery } from "../gateway/operator-run-recovery.test-support.js";
import * as gatewayDispatch from "../gateway/server-in-process-dispatch.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resumeMarkedSessions } from "../gateway/session-restart-resume.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { applyQueueDropPolicy } from "../utils/queue-helpers.js";
import {
  generateDurablePilotSequence,
  generatePilotSequence,
  initialPilotState,
  modelParentMailbox,
  stepDurablePilot,
  stepPilot,
  stepPilotMailbox,
  type DurablePilotEvent,
  type DurablePilotState,
  type PilotCustody,
  type PilotEvent,
  type PilotInput,
  type PilotMailbox,
  type PilotParentInput,
} from "./session-controller-model.test-support.js";
import type { ReplyMessageInjectionAttempt } from "./session-controller.contracts.js";
import { createReplyOperation, getSessionControllerOperation } from "./session-controller.js";
import {
  beginSessionEffect,
  startSessionControllerInterruption,
} from "./session-controller.lifecycle.js";
import {
  clearSessionControllerMailbox,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
} from "./session-controller.mailbox.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";

type Receipt = PilotEvent & { type: "receipt" };
const deliverySettlement = [{ type: "complete" }, { type: "delivery-settled" }] as const;

function reserve(
  key: string,
  options: Partial<Parameters<typeof reserveSessionControllerSource>[1]> = {},
) {
  return reserveSessionControllerSource(key, { policy: { mode: "followup" }, ...options });
}

function release(claim: SessionControllerMailboxClaim) {
  releaseSessionControllerClaim(claim);
  return claim.settlement.promise;
}

function operationFor(sessionKey: string, sessionId = "pilot-session") {
  return createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
}

function recordClaim(source: SessionControllerInput, turns: string[], id = source.sourceTurnId!) {
  return claimSessionControllerTask(source, () => {
    turns.push(id);
  });
}

/** Calls public owner operations, never the runtime reducer under test. */
async function replay(events: readonly PilotEvent[], label: string) {
  let model = initialPilotState();
  let live = true;
  const sourceRevoked = new Error("source revoked");
  let compacting = false;
  let injectionAvailable = true;
  let writer = true;
  const key = "agent:main:controller-pilot";
  const gates = new Map<string, ReturnType<typeof createDeferredCore<Receipt>>>();
  const attempts = new Map<string, ReplyMessageInjectionAttempt>();
  const custody = new Map<string, PilotCustody>();
  const effects: string[] = [];
  const deliveries: ReturnType<typeof createDeferredCore<void>>[] = [];
  const operations: ReturnType<typeof createReplyOperation>[] = [];
  const create = () => {
    const operation = operationFor(key);
    const delivery = createDeferredCore();
    deliveries.push(delivery);
    operations.push(operation);
    void operation.ownerSettlement?.then(() => {
      if (current.operation === operation) {
        writer = false;
      }
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "pilot-run",
      toolAuthorityFingerprint: "alice-policy",
      cancel: () => {
        effects.push("cancel");
      },
      isCompacting: () => compacting,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => injectionAvailable,
        async queueMessage(_text, options, assertCurrent) {
          const id = options?.queueIdentity;
          if (!id) {
            throw new Error("Missing input identity");
          }
          effects.push("inject:" + id);
          const gate = createDeferredCore<Receipt>();
          gates.set(id, gate);
          const receipt = await gate.promise;
          assertCurrent();
          if (receipt.outcome === "indeterminate") {
            throw new QuestionAnswerUnconfirmedError("unknown acceptance");
          }
          if (receipt.outcome === "rejected") {
            throw new Error("backend rejected");
          }
          options?.onQueueAccepted?.(true);
        },
      },
    });
    return { operation, delivery };
  };
  let current = create();
  const prefix: PilotEvent[] = [];
  try {
    for (const event of events) {
      prefix.push(event);
      const expected = stepPilot(model, event);
      const beforeEffects = effects.length;
      switch (event.type) {
        case "run":
          current.operation.setPhase("running");
          break;
        case "finish":
          current.operation.freezeAbort();
          break;
        case "stop":
          current.operation.abortByUser();
          break;
        case "injection-available":
          injectionAvailable = event.available;
          break;
        case "compact":
          compacting = event.active;
          break;
        case "revoke":
          live = false;
          break;
        case "complete":
          current.operation.completeWithAfterClearBarrier(current.delivery.promise);
          break;
        case "delivery-settled":
          current.delivery.resolve();
          await current.operation.ownerSettlement;
          break;
        case "replace":
          current = create();
          live = true;
          compacting = false;
          injectionAvailable = true;
          writer = true;
          break;
        case "offer": {
          const target = captureCurrentReplyMessageInjectionTarget(key);
          if (!target) {
            custody.set(event.input.id, "rejected");
            break;
          }
          const attempt = await beginReplyMessageInjectionTarget(target, event.input.id, {
            queueIdentity: event.input.id,
            isInboundUserMessage: true,
            toolAuthorityFingerprint: event.input.authority,
            assertCurrent: () => {
              if (!live) {
                throw sourceRevoked;
              }
            },
          }).catch((error: unknown) => {
            if (error !== sourceRevoked) {
              throw error;
            }
            return undefined;
          });
          if (!attempt) {
            custody.set(event.input.id, "failed");
            break;
          }
          attempts.set(event.input.id, attempt);
          custody.set(
            event.input.id,
            gates.has(event.input.id) ? "offered" : (await attempt.outcome).status,
          );
          break;
        }
        case "receipt": {
          const gate = gates.get(event.id);
          const attempt = attempts.get(event.id);
          if (!gate || !attempt) {
            break;
          }
          gate.resolve(event);
          const outcome = await attempt.outcome;
          custody.set(event.id, outcome.status);
          if (outcome.status === "accepted" || outcome.status === "indeterminate") {
            expect(await attempt.acceptance).toBe(true);
          }
          gates.delete(event.id);
          break;
        }
      }
      await Promise.resolve();
      model = expected.state;
      const context = label + " prefix=" + JSON.stringify(prefix);
      expect(getSessionControllerOperation(key) === current.operation, context).toBe(model.slot);
      expect(current.operation.abortSignal.aborted, context).toBe(model.cancelled);
      expect(writer, context).toBe(model.writer);
      expect(effects.slice(beforeEffects), context).toEqual(
        expected.effects.flatMap((effect) =>
          effect.type === "cancel"
            ? ["cancel"]
            : effect.type === "inject"
              ? ["inject:" + effect.input.id]
              : [],
        ),
      );
      for (const [id, input] of Object.entries(model.inputs)) {
        expect(custody.get(id), context).toBe(input.custody);
      }
    }
  } finally {
    for (const [id, gate] of gates) {
      gate.resolve({ type: "receipt", id, outcome: "accepted" });
    }
    for (const delivery of deliveries) {
      delivery.resolve();
    }
    for (const operation of operations) {
      operation.complete();
    }
    await Promise.all([...attempts.values()].map((attempt) => attempt.outcome));
    await Promise.all(operations.map((operation) => operation.ownerSettlement));
  }
}

describe("session controller executable pilot", () => {
  it("gives each owed completion and settle identity exactly one FIFO parent turn", async () => {
    const key = "agent:main:completion-mailbox-model";
    const active = operationFor(key, "active");
    active.setPhase("running");
    const offered: PilotParentInput[] = [
      { id: "user-before", kind: "user", owedAt: 1 },
      { id: "completion:a:1", kind: "completion", owedAt: 2 },
      { id: "completion:a:1", kind: "completion", owedAt: 2 },
      { id: "settle:batch:1:0", kind: "settle", owedAt: 3 },
      { id: "user-after", kind: "user", owedAt: 4 },
    ];
    const expected = modelParentMailbox(offered);
    const sources = offered.map((input, index) =>
      reserve(key, {
        reservationId: input.kind === "user" ? undefined : input.id,
        protocolRunId: input.kind === "user" ? `${input.id}:${index}` : input.id,
      }),
    );
    expect(sources[1]).toBe(sources[2]);
    const unique = sources.filter((source, index) => sources.indexOf(source) === index);
    const turns: string[] = [];
    const pending = unique.map((source) =>
      recordClaim(source, turns, offered[sources.indexOf(source)]!.id),
    );
    active.abortByUser();
    active.complete();
    try {
      for (const claim of pending) {
        await release(await claim);
      }
      expect(turns).toEqual(expected.map((input) => input.id));
      expect(turns).toEqual(["user-before", "completion:a:1", "settle:batch:1:0", "user-after"]);
    } finally {
      for (const source of unique) {
        retireSessionControllerInput(source);
      }
      clearSessionControllerMailbox(unique[0]!.mailbox, () => {});
    }
  });

  it("rebuilds reset completion and settle obligations once in persisted owed order", async () => {
    const key = "agent:main:completion-mailbox-reset-model";
    const owed = modelParentMailbox([
      { id: "settle:later", kind: "settle", owedAt: 20 },
      { id: "completion:earlier", kind: "completion", owedAt: 10 },
    ]).toSorted((a, b) => a.owedAt - b.owedAt);
    const rebuild = () => owed.map((input) => reserve(key, { reservationId: input.id }));
    const initial = rebuild();
    clearSessionControllerMailbox(initial[0]!.mailbox, () => {});
    await Promise.allSettled(initial.map((source) => source.settlement.promise));
    const rebuilt = rebuild();
    const turns: string[] = [];
    try {
      for (const source of rebuilt) {
        await release(await recordClaim(source, turns));
      }
      expect(turns).toEqual(["completion:earlier", "settle:later"]);
    } finally {
      for (const source of rebuilt) {
        retireSessionControllerInput(source);
      }
    }
  });

  it("replays 2048 state-aware sequences with delayed receipts (48 generated steps each)", async () => {
    vi.useFakeTimers();
    try {
      for (let seed = 1; seed <= 2048; seed++) {
        await replay(generatePilotSequence(seed), "seed=" + seed);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([7, 41])(
    "conserves durable custody across crash/replay with intercepted dispatch/model (seed=%s)",
    (seed) =>
      withRecovery(async (fixture, _stateDir, profile) => {
        setRuntimeConfigSnapshot({});
        vi.useFakeTimers({ toFake: ["Date"] });
        const receipts = new Map<string, SessionPendingInputReceipt>();
        const sources = new Map<string, SessionControllerInput>();
        const claims = new Map<string, SessionControllerMailboxClaim>();
        const executions: string[] = [];
        const expectedExecutions: string[] = [];
        const target = fixture.target;
        const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(target)));
        const events = generateDurablePilotSequence(seed);
        const inputs = events.flatMap((event) => (event.type === "append" ? [event.input] : []));
        const message = (id: string) => ({
          role: "user" as const,
          content: `Accepted input ${id}: ünicode 🦞`,
          timestamp: 1,
          idempotencyKey: `${id}:user`,
          __openclaw: { senderIdentity: { type: "profile" as const, id: profile.id } },
        });
        const stage = async (id: string) => {
          const input = inputs.find((candidate) => candidate.id === id)!;
          const receipt = await stageSessionPendingInput(target, {
            runId: id,
            message: message(id),
            requestFingerprint: id,
            ...(input.recoverable
              ? { recoverySource: { kind: "gateway" as const, snapshot: fixture.snapshot } }
              : {}),
            assertCurrent() {},
          });
          assert(receipt, "Expected real durable input acceptance");
          receipts.set(id, receipt);
          return receipt;
        };
        const claim = async (id: string) => {
          const source = reserve(target.sessionKey, { protocolRunId: id });
          sources.set(id, source);
          claims.set(id, await claimSessionControllerTask(source, () => {}));
        };
        const releaseClaim = async (id: string) => {
          const held = claims.get(id);
          if (held) {
            await release(held);
            claims.delete(id);
          }
          const source = sources.get(id);
          if (source) {
            retireSessionControllerInput(source);
            sources.delete(id);
          }
        };
        const adopt = async (id: string) => {
          const receipt = receipts.get(id)!;
          assert(receipt.state === "queued", "Consumed input must not execute again");
          await receipt.run(() => appendTranscriptMessage(target, { message: receipt.message }));
          executions.push(id);
          await releaseClaim(id);
        };
        let dispatchAvailable = false;
        // Only the execution endpoint is intercepted. Acceptance, original-source
        // restoration, startup discovery, row consumption, and transcript writes are real.
        const dispatch = vi
          .spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess")
          .mockImplementation(async (method, params) => {
            assert(method === "chat.send");
            assert(params && typeof params === "object" && "idempotencyKey" in params);
            const id = String(params.idempotencyKey);
            if (!dispatchAvailable) {
              throw new GatewayDispatchUnavailableError(method, true);
            }
            const receipt = await stage(id);
            assert(receipt.state === "queued", "Startup must not dispatch a consumed input");
            await claim(id);
            await adopt(id);
            return {};
          });
        let model: DurablePilotState = {};
        const prefix: DurablePilotEvent[] = [];
        try {
          for (const event of events) {
            prefix.push(event);
            vi.setSystemTime(Date.now() + 17);
            switch (event.type) {
              case "append":
                await stage(event.input.id);
                break;
              case "claim":
                await claim(event.id);
                break;
              case "adopt":
                await adopt(event.id);
                expectedExecutions.push(event.id);
                break;
              case "crash": {
                // Release test-process resources without changing accepted rows.
                // No session resume marker or queued-input source map is persisted.
                const captured = await captureSessionQueuedInputsForRestart(target);
                captured.preserve();
                for (const [id, receipt] of receipts) {
                  await releaseClaim(id);
                  receipt.finish("interrupted", "restart-unrecoverable");
                  await receipt.settled?.();
                }
                receipts.clear();
                rotateAgentEventLifecycleGeneration();
                break;
              }
              case "replay": {
                if (event.dispatchAvailable) {
                  expectedExecutions.push(
                    ...Object.entries(model)
                      .filter(([, input]) => input.custody === "queued" && input.recoverable)
                      .map(([id]) => id),
                  );
                }
                dispatchAvailable = event.dispatchAvailable;
                const context = createContext();
                context.resolveGatewayContext = () => context;
                await resumeMarkedSessions({
                  context,
                  signal: new AbortController().signal,
                  log: { warn() {} },
                });
                break;
              }
              case "resend": {
                const receipt = await stage(event.id);
                // A committed replay receipt retains completion custody, not another admission.
                await receipt.validateCommittedReplay!();
                receipt.release();
                await receipt.settled?.();
                expect(
                  await readSessionSubmittedInput(target, `${event.id}:user`, {
                    includeSource: true,
                  }),
                ).toMatchObject({ source: "transcript", message: message(event.id) });
                break;
              }
            }
            model = stepDurablePilot(model, event);
            const context = `seed=${seed} prefix=${JSON.stringify(prefix)}`;
            expect(executions, context).toEqual(expectedExecutions);
            const rows = database.db
              .prepare("SELECT * FROM session_pending_inputs WHERE session_key = ?")
              .all(target.sessionKey);
            expect(rows, context).toHaveLength(
              Object.values(model).filter((input) => input.custody !== "consumed").length,
            );
            for (const [id, input] of Object.entries(model)) {
              const row = rows.find((candidate) => candidate.run_id === id);
              const committed = database.db
                .prepare(
                  "SELECT event_id FROM transcript_event_identities WHERE session_id = ? AND message_idempotency_key = ?",
                )
                .all(target.sessionId, `${id}:user`);
              expect(committed, context).toHaveLength(input.custody === "consumed" ? 1 : 0);
              if (input.custody === "consumed") {
                expect(row, context).toBeUndefined();
              } else {
                assert(row, context);
                expect(row.message_json, context).toBe(JSON.stringify(message(id)));
                expect(row.consumed_event_id, context).toBeNull();
                expect(row.state, context).toBe(
                  input.custody === "queued" ? "queued" : "cancelled",
                );
                expect(row.end_cause ?? undefined, context).toBe(
                  input.custody === "queued" ? undefined : "restart-unrecoverable",
                );
              }
              expect(
                executions.filter((executed) => executed === id),
                context,
              ).toHaveLength(input.custody === "consumed" ? 1 : 0);
            }
          }
        } finally {
          dispatch.mockRestore();
          for (const [id, receipt] of receipts) {
            await releaseClaim(id);
            receipt.finish("interrupted", "restart-unrecoverable");
            await receipt.settled?.();
          }
          vi.useRealTimers();
        }
      }),
  );

  it.each<{ name: string; events: PilotEvent[] }>([
    {
      name: "keeps finishing cancellation separate from the backend injection capability",
      events: [
        { type: "run" },
        { type: "finish" },
        { type: "offer", input: { id: "still-available", authority: "alice-policy" } },
        { type: "receipt", id: "still-available", outcome: "accepted" },
        { type: "injection-available", available: false },
        { type: "offer", input: { id: "closed", authority: "alice-policy" } },
        { type: "stop" },
        ...deliverySettlement,
      ],
    },
    {
      name: "retains uncertain input custody while refusing another sender during compaction",
      events: [
        { type: "run" },
        { type: "compact", active: true },
        { type: "offer", input: { id: "other-sender", authority: "bob-policy" } },
        { type: "offer", input: { id: "uncertain", authority: "alice-policy" } },
        { type: "receipt", id: "uncertain", outcome: "indeterminate" },
        { type: "revoke" },
        { type: "stop" },
        ...deliverySettlement,
      ],
    },
    {
      name: "rejects a delayed receipt from a same-ID replaced operation",
      events: [
        { type: "run" },
        { type: "offer", input: { id: "old-input", authority: "alice-policy" } },
        ...deliverySettlement,
        { type: "replace" },
        { type: "run" },
        { type: "receipt", id: "old-input", outcome: "accepted" },
        ...deliverySettlement,
      ],
    },
  ])("$name", async ({ name, events }) => replay(events, name));

  it("keeps a restart-interrupted lifecycle lease until the actual owner and delivery settle", async () => {
    const operation = operationFor("agent:main:pilot-lease", "pilot-lease");
    operation.setPhase("running");
    const delivery = createDeferredCore();
    const lease = await beginSessionEffect({
      scope: "pilot-store",
      identities: [operation.key, operation.sessionId],
      assertAllowed: () => {},
      onInterrupt: (reason) => {
        operation.abort(reason);
      },
    });
    const ownerReleased = operation.ownerSettlement.then(() => lease.release());
    let effectSettled = false;
    void lease.released.then(() => {
      effectSettled = true;
    });
    try {
      const interruption = startSessionControllerInterruption({
        scope: "pilot-store",
        identities: [operation.key],
        reason: createAgentRunRestartAbortError(),
      });
      expect(operation.abortSignal.aborted).toBe(true);
      expect(lease.isActive()).toBe(false);
      expect(effectSettled).toBe(false);
      const interrupted = lease.run(async () => {}).catch((error: unknown) => error);
      expect(isAgentRunRestartAbortReason(await interrupted)).toBe(true);
      operation.completeWithAfterClearBarrier(delivery.promise);
      await Promise.resolve();
      expect(effectSettled).toBe(false);
      delivery.reject(new Error("delivery failed"));
      await ownerReleased;
      await interruption.released;
      expect(effectSettled).toBe(true);
      expect(lease.isActive()).toBe(false);
    } finally {
      delivery.resolve();
      operation.complete();
      await ownerReleased;
      lease.release();
    }
  });

  it.each(["old", "new"] as const)(
    "conserves overflow identities against the existing %s queue boundary",
    (dropPolicy) => {
      let model: PilotMailbox = { capacity: 2, waiting: [], retired: [] };
      const queue = {
        cap: 2,
        items: [] as PilotInput[],
        dropPolicy,
        droppedCount: 0,
        summaryLines: [] as string[],
      };
      const retired: string[] = [];
      for (let n = 0; n < 6; n++) {
        const input = { id: "mail-" + n, authority: n % 2 ? "alice-policy" : "bob-policy" };
        model = stepPilotMailbox(model, { type: "enqueue", input, overflow: dropPolicy }).state;
        if (
          applyQueueDropPolicy({
            queue,
            summarize: (item) => item.id,
            onDrop: (items) => retired.push(...items.map((item) => item.id)),
          })
        ) {
          queue.items.push(input);
        } else {
          retired.push(input.id);
        }
        expect(queue.items).toEqual(model.waiting);
        expect(retired).toEqual(model.retired);
        expect(queue.items.length + retired.length).toBe(n + 1);
      }
    },
  );
});
