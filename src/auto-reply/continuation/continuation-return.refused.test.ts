// A return whose recipient authority advanced is refused at every boundary that sees it: never
// queued, woken, adopted or acknowledged, and reported with its reason. Real: the agent database
// and its authority epochs, the producer, the durable session-delivery queue, restart recovery and
// prompt adoption. Observed only: wake requests (process-external) and log lines.
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as accessor from "../../config/sessions/session-accessor.js";
import type { SessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-types.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import {
  deliverQueuedSessionDelivery,
  recoverPendingProducedSessionDeliveries,
} from "../../gateway/server-restart-sentinel.js";
import {
  inspectDeliveryQueueReceipt,
  pruneExpiredDeliveryQueueTombstones,
} from "../../infra/delivery-queue-sqlite.js";
import { captureDeliveryQueueStateContext } from "../../infra/delivery-queue-state-context.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
} from "../../infra/session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  failSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import {
  enqueueSystemEventRaw,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveFinalSystemEventAdoption,
  settleManagedSystemEventsAfterTurnAdoption,
} from "../reply/session-system-event-adoption.js";
import { prepareFormattedSystemEvents } from "../reply/session-system-events.js";
import { requestContinuationWake } from "./continuation-wake.js";
import { captureContinuationQueueContext } from "./queue-context.js";
import { enqueueContinuationReturnDeliveries } from "./targeting.js";

// mock-isolation: Continuation wakes are recorded without running the session-event handoff.
vi.mock("./continuation-wake.js", () => ({ requestContinuationWake: vi.fn() }));
const logLines = vi.hoisted(() => [] as string[]);
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      const record =
        (level: "info" | "warn") => (message: string, meta?: Record<string, unknown>) => {
          logLines.push(message);
          logger[level](message, meta);
        };
      return { ...logger, info: record("info"), warn: record("warn") };
    },
  };
});

const ownerA = { type: "human" as const, source: "unknown" as const, id: "owner-a" };
const ownerB = { type: "human" as const, id: "owner-b" };
type Scope = { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };

const transitions: Record<string, (scope: Scope) => Promise<unknown>> = {
  "delete and recreate": async (scope) => {
    await accessor.deleteSessionEntryLifecycle({
      agentId: scope.agentId,
      archiveTranscript: false,
      storePath: resolveOpenClawAgentSqlitePath(scope),
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });
    await accessor.upsertSessionEntryCore(scope, { sessionId: "recreated", updatedAt: 3 });
  },
  "owner change": async (scope) =>
    accessor.assignSessionOwner(scope, { owner: ownerB, assignedBy: ownerA, assignedAt: 3 }),
  "visibility narrowing": (scope) =>
    accessor.patchSessionEntryCore(scope, () => ({ visibility: "draft" })),
  "member removal": (scope) => removeSessionMember(scope, "member-a"),
  // Epochs never come back: reassigning the original owner keeps the old binding stale.
  "reassignment back to the original owner": async (scope) => {
    accessor.assignSessionOwner(scope, { owner: ownerB, assignedBy: ownerA, assignedAt: 3 });
    accessor.assignSessionOwner(scope, { owner: ownerA, assignedBy: ownerB, assignedAt: 4 });
  },
};
const transitionTo = (transition: string, scope: Scope) => () => transitions[transition]!(scope);
const discardLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const stages = {
  enqueue: "enqueue",
  "enqueue, after its row is written": "enqueue",
  "restart replay": "replay",
  "prompt drain": "prompt-drain",
  "final adoption": "prompt-drain",
} as const;
type Stage = keyof typeof stages;

afterEach(() => {
  logLines.length = 0;
  vi.mocked(requestContinuationWake).mockClear();
  resetSystemEventsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

async function withRecipient(
  run: (scope: Scope, authority: SessionRecipientAuthority, workspaceDir: string) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
    setRuntimeConfigSnapshot({});
    await state.writeConfig({});
    await captureRuntimeConfigAsyncReader()();
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:recipient" };
    await accessor.upsertSessionEntryCore(scope, {
      sessionId: "recipient",
      updatedAt: 1,
      createdActor: ownerA,
      visibility: "shared",
    });
    await addSessionMember(scope, { identityId: "member-a", addedBy: ownerA.id, addedAt: 2 });
    await run(scope, await accessor.captureSessionRecipientAuthority(scope), state.workspaceDir);
  });
}

/**
 * The real producer; `beforeWrite` runs after its authority read, `afterWrite` once the durable row
 * exists, before the event is queued. `ambient` omits the state dir, as the announce producer does.
 */
async function produce(
  scope: Scope,
  authority: SessionRecipientAuthority,
  {
    beforeWrite,
    afterWrite,
    ambient,
  }: { beforeWrite?: () => unknown; afterWrite?: () => unknown; ambient?: boolean } = {},
) {
  const written: string[] = [];
  const outcome = await enqueueContinuationReturnDeliveries(
    {
      targetSessionKeys: [scope.sessionKey],
      text: "delegate result",
      idempotencyKeyBase: "continuation-return:refused",
      recipientAuthorities: new Map([[scope.sessionKey, authority]]),
      wakeRecipients: true,
      ownerAgentId: "main",
      ...(ambient ? {} : { stateDir: scope.env.OPENCLAW_STATE_DIR }),
    },
    {
      enqueueSessionDelivery: async (...args) => {
        await beforeWrite?.();
        written.push(await enqueueSessionDelivery(...args));
        await afterWrite?.();
        return written.at(-1)!;
      },
      enqueueSystemEvent: enqueueSystemEventRaw,
      requestContinuationWake,
    },
  );
  return { outcome, id: written[0] };
}

/** A restart: the in-memory event and wake are gone, then recovery replays the durable row. */
async function restartAndReplay(scope: Scope, beforeReplay?: () => unknown) {
  resetSystemEventsForTest();
  vi.mocked(requestContinuationWake).mockClear();
  await beforeReplay?.();
  const recovery = discardLog();
  await recoverPendingProducedSessionDeliveries({
    deps: {},
    queueContext: captureContinuationQueueContext(scope.env.OPENCLAW_STATE_DIR),
    log: recovery,
  });
  return recovery;
}

/** The recipient's next turn adopts and acknowledges what it may; returns its prompt. */
async function nextTurn(
  scope: Scope,
  hooks: { beforeAdoption?: () => unknown; afterAdoption?: () => unknown } = {},
) {
  const prepared = await prepareFormattedSystemEvents({
    cfg: {},
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    isMainSession: false,
    isNewSession: false,
  });
  await hooks.beforeAdoption?.();
  let adoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
  while (adoption.kind === "settle-stale") {
    await adoption.settle();
    adoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
  }
  await hooks.afterAdoption?.();
  const ackIds = [...adoption.managedDeliveries.keys()];
  await settleManagedSystemEventsAfterTurnAdoption({
    deliveries: adoption.managedDeliveries.values(),
    persistedMessage: { __openclaw: { sessionDeliveryAckIds: ackIds } },
  });
  return adoption.blocks.map((block) => block.text).join("\n");
}

async function receiptStatus(scope: Scope, id: string) {
  const context = captureDeliveryQueueStateContext(scope.env.OPENCLAW_STATE_DIR);
  return (await inspectDeliveryQueueReceipt("session", id, false, context)).status;
}

const refusalLines = () =>
  logLines.filter((line) => line.startsWith("[continuation:return-refused]"));
const refusalLine = (stage: string, sessionKey: string, id?: string) =>
  `[continuation:return-refused] stage=${stage} reason=recipient-authority-changed session=${sessionKey}${id ? ` deliveryId=${id}` : ""}`;

describe("a continuation return whose recipient authority advanced", () => {
  const cases = Object.keys(transitions).flatMap((transition) =>
    (Object.keys(stages) as Stage[]).map((stage) => [transition, stage] as const),
  );
  it.each(cases)("is refused after %s, at %s", async (transition, stage) => {
    await withRecipient(async (scope, authority) => {
      const advance = () => transitions[transition]!(scope);
      let id: string | undefined;
      if (stage === "enqueue" || stage === "enqueue, after its row is written") {
        const beforeWrite = stage === "enqueue";
        if (beforeWrite) {
          await advance();
        }
        const produced = await produce(scope, authority, {
          afterWrite: beforeWrite ? undefined : advance,
        });
        id = produced.id;
        expect(produced.outcome).toMatchObject({
          deliveryIds: [],
          deliveredSessionKeys: [],
          refusedSessionKeys: [scope.sessionKey],
        });
      } else {
        id = (await produce(scope, authority)).id;
        vi.mocked(requestContinuationWake).mockClear();
        if (stage === "restart replay") {
          const recovery = await restartAndReplay(scope, advance);
          expect(recovery.info).not.toHaveBeenCalledWith(`Recovered session delivery ${id}`);
        } else if (stage === "prompt drain") {
          await advance();
        }
      }

      // No final effect: no wake, no queued event, no adoption and no acknowledgement.
      const beforeAdoption = stage === "final adoption" ? advance : undefined;
      expect(await nextTurn(scope, { beforeAdoption })).not.toContain("delegate result");
      expect(requestContinuationWake).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
      // Only a refusal before the write leaves no row; every written row keeps its failed receipt.
      if (stage === "enqueue") {
        expect(id).toBeUndefined();
      } else {
        expect(await receiptStatus(scope, id!)).toBe("failed");
      }
      expect(refusalLines()).toEqual([refusalLine(stages[stage], scope.sessionKey, id)]);
    });
  });

  it.each(["inside", "after"] as const)(
    "fences a duplicate announce %s its refused row's receipt window, never adopting it",
    async (window) => {
      await withRecipient(async (scope, authority) => {
        // The duplicate reads authority before the change and writes after the refusal settled.
        let reachedWrite!: () => void;
        let releaseWrite!: () => void;
        const atWrite = new Promise<void>((resolve) => (reachedWrite = resolve));
        const released = new Promise<void>((resolve) => (releaseWrite = resolve));
        let id: string | undefined;
        let statusAtWrite: string | undefined;
        const duplicate = produce(scope, authority, {
          beforeWrite: () => {
            reachedWrite();
            return released;
          },
          afterWrite: async () => {
            statusAtWrite = await receiptStatus(scope, id!);
          },
        });
        await atWrite;
        ({ id } = await produce(scope, authority, {
          afterWrite: transitionTo("owner change", scope),
        }));
        if (window === "after") {
          expect(await receiptStatus(scope, id!)).toBe("failed");
          // Past the 30-day bound, the maintenance sweep removes the receipt and frees the id.
          openOpenClawStateDatabase({ env: scope.env })
            .db.prepare(
              "UPDATE delivery_queue_entries SET enqueued_at = enqueued_at - ? WHERE queue_name = 'session' AND id = ?",
            )
            .run(31 * 86_400_000, id!);
          await pruneExpiredDeliveryQueueTombstones(scope.env.OPENCLAW_STATE_DIR);
          expect(await receiptStatus(scope, id!)).toBeUndefined();
        }
        releaseWrite();
        const { outcome } = await duplicate;

        // Inside the window the receipt fences the write; after it, the write lands and is refused.
        expect(statusAtWrite).toBe(window === "inside" ? "failed" : "pending");
        expect(outcome).toMatchObject({ deliveryIds: [], refusedSessionKeys: [scope.sessionKey] });
        expect(await nextTurn(scope)).not.toContain("delegate result");
        expect(requestContinuationWake).not.toHaveBeenCalled();
        expect(await receiptStatus(scope, id!)).toBe("failed");
        expect(refusalLines()).toEqual(Array(2).fill(refusalLine("enqueue", scope.sessionKey, id)));
      });
    },
  );

  it("keeps its receipt when the process dies between the replay's refusal and its terminal write", async () => {
    await withRecipient(async (scope, authority) => {
      const { id } = await produce(scope, authority);
      // A restart drops the queued copy, so replay alone holds the row once the owner changes.
      resetSystemEventsForTest();
      await transitionTo("owner change", scope)();
      // That restart's recovery refuses the row and dies inside settlement, before the row's write.
      await recoverPendingSessionDeliveries({
        queueContext: captureContinuationQueueContext(scope.env.OPENCLAW_STATE_DIR),
        log: discardLog(),
        deliver: (entry, context) => deliverQueuedSessionDelivery({ deps: {}, entry, ...context }),
        onSettled: () => {
          throw new Error("process died");
        },
      });
      expect(await receiptStatus(scope, id!)).toBe("pending");

      await restartAndReplay(scope);
      expect(await receiptStatus(scope, id!)).toBe("failed");
      expect(await nextTurn(scope)).not.toContain("delegate result");
      expect(requestContinuationWake).not.toHaveBeenCalled();
      expect(refusalLines()).toEqual(Array(2).fill(refusalLine("replay", scope.sessionKey, id)));
    });
  });

  it("is deleted as before when its retry budget dead-letters it before any refusal", async () => {
    await withRecipient(async (scope, authority) => {
      const { id } = await produce(scope, authority);
      const queueContext = captureContinuationQueueContext(scope.env.OPENCLAW_STATE_DIR);
      // The default budget is five; recovery retires an exhausted row without replaying it.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await failSessionDelivery(id!, "replay failed", queueContext);
      }
      await restartAndReplay(scope, transitionTo("owner change", scope));

      expect(await receiptStatus(scope, id!)).toBeUndefined();
      expect(await nextTurn(scope)).not.toContain("delegate result");
      expect(refusalLines()).toEqual([]);
    });
  });

  it.each(["no authority change", "a session reset"])(
    "is replayed and adopted as before after %s",
    async (control) => {
      await withRecipient(async (scope, authority, workspaceDir) => {
        const { id } = await produce(scope, authority);
        // A reset replaces the head, not the recipient: it never advances the epoch.
        await restartAndReplay(scope, () =>
          control === "no authority change"
            ? undefined
            : accessor.resetSessionEntryLifecycle({
                agentId: scope.agentId,
                storePath: resolveOpenClawAgentSqlitePath(scope),
                target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
                resetBoundary: { context: "clear", reason: "reset", cwd: workspaceDir },
                buildNextEntry: () => ({ sessionId: "after-reset", updatedAt: 3 }),
              }),
        );

        expect(requestContinuationWake).toHaveBeenCalledWith(
          expect.objectContaining({ sessionKey: scope.sessionKey, deliveryIds: [id] }),
        );
        expect(await nextTurn(scope)).toContain("delegate result");
        expect(await receiptStatus(scope, id!)).toBe("completed");
        expect(refusalLines()).toEqual([]);
      });
    },
  );

  it.each(["an explicit state dir", "the ambient state dir, written non-canonically"])(
    "stays adopted when it changes after a turn adopted it and the sweep re-drives its row, with %s",
    async (stateDirForm) => {
      await withRecipient(async (scope, authority) => {
        const ambient = stateDirForm !== "an explicit state dir";
        if (ambient) {
          // The same directory as the queue's resolved one, spelled differently.
          vi.stubEnv("OPENCLAW_STATE_DIR", `${scope.env.OPENCLAW_STATE_DIR}/`);
        }
        const { id } = await produce(scope, authority, { ambient });
        const queueContext = captureContinuationQueueContext(scope.env.OPENCLAW_STATE_DIR);
        const afterAdoption = async () => {
          await transitions["owner change"]!(scope);
          // The in-process sweep keeps live adoption claims; only startup recovery drops them.
          await drainPendingSessionDelivery({
            id: id!,
            queueContext,
            bypassBackoff: true,
            logLabel: "sweep",
            log: discardLog(),
            deliver: (entry, context) =>
              deliverQueuedSessionDelivery({ deps: {}, entry, ...context }),
          });
        };

        expect(await nextTurn(scope, { afterAdoption })).toContain("delegate result");
        expect(await receiptStatus(scope, id!)).toBe("completed");
        expect(refusalLines()).toEqual([]);
      });
    },
  );
});
