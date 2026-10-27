import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { spyAgentExecutions } from "../../config/sessions/session-native-binding.execution.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

// mock-isolation: Fixture seed writes must not schedule retention requests into this census.
vi.mock("../../config/sessions/session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));

describe("pending final transport settlement", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-final-");
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";

  beforeEach(() => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
  });

  const scope = () => ({ storePath, sessionKey });
  const readEntry = () => loadSessionEntry(scope()) as SessionEntry;
  async function writePendingFinal(...states: ("prepared" | "delivered")[]): Promise<void> {
    const entry: SessionEntry = {
      sessionId: "session",
      startedAt: 10,
      lifecycleRunId: "active-run",
      updatedAt: 1,
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: 1,
        intentId: "intent-1",
        deliveries: states.map((state, index) => ({ id: `delivery-${index + 1}`, state })),
      },
    };
    await replaceSessionEntry(scope(), entry);
  }

  function pendingFinalPayload(deliveryId = "delivery-1"): ReplyPayload {
    return setReplyPayloadMetadata(
      { text: "hook reply" },
      {
        pendingFinalDeliveryCompletion: {
          deliveryId,
          intentId: "intent-1",
          sessionId: "session",
          sessionKey,
          storePath,
        },
      },
    );
  }

  it("settles hook delivery without changing user activity", async () => {
    await writePendingFinal("prepared");
    const payload = setReplyPayloadMetadata(pendingFinalPayload(), {
      pendingFinalDeliveryCleanup: { preserveActivity: true },
    });
    const entered = createDeferred();
    const delivered = createDeferred();
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (reply) => ({ ...reply, replyToId: "message-1" }),
      async deliver() {
        entered.resolve();
        await delivered.promise;
      },
    });

    const sql = observeHostDataSql();
    try {
      expect(dispatcher.sendFinalReply(payload)).toBe(true);
      dispatcher.markComplete();
      await entered.promise;
      const sending = await readSessionEntryReadOnlyInWorker({ sessionKey, storePath });
      expect(sending?.pendingFinalDelivery?.deliveries).toEqual([
        { id: "delivery-1", state: "queued" },
      ]);
      delivered.resolve();
      await dispatcher.waitForIdle();
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      delivered.resolve();
      await dispatcher.waitForIdle();
      sql.restore();
    }

    const entry = readEntry();
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.lifecycleRunId).toBeUndefined();
    expect(entry).toMatchObject({
      status: "done",
      abortedLastRun: false,
      endedAt: expect.any(Number),
      updatedAt: 1,
    });
    expect(entry?.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("clears a skipped turn only after every sendable final is suppressed", async () => {
    await writePendingFinal("prepared", "prepared");

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-1"), {
      preserveActivity: true,
    });

    expect(readEntry().pendingFinalDelivery?.deliveries).toEqual([
      { id: "delivery-1", state: "suppressed" },
      { id: "delivery-2", state: "prepared" },
    ]);

    await suppressPendingFinalDelivery(pendingFinalPayload("delivery-2"), {
      preserveActivity: true,
    });

    const entry = readEntry();
    expect(entry.pendingFinalDelivery).toBeUndefined();
    expect(entry.status).toBeUndefined();
    expect(entry).toMatchObject({ lifecycleRunId: "active-run", updatedAt: 1 });
  });

  it("cleans only the current completed intent after a foreign commit", async () => {
    await writePendingFinal("delivered");
    const targetScope = scope();
    const original = readEntry();
    const identity = getReplyPayloadMetadata(pendingFinalPayload())?.pendingFinalDeliveryCompletion;
    let beforeCommit: (() => void) | undefined;
    spyAgentExecutions(agentExecution, (worker) => ({
      execute: (command, options) => {
        if (command.type === "session.entry.patch.commit") {
          const change = beforeCommit;
          beforeCommit = undefined;
          change?.();
        }
        return worker.execute(command, options);
      },
    }));
    try {
      for (const change of [
        { label: "foreign metadata" },
        { sessionId: "replacement" },
        { pendingFinalDelivery: { ...original.pendingFinalDelivery!, intentId: "new-intent" } },
        {
          pendingFinalDelivery: {
            ...original.pendingFinalDelivery!,
            deliveries: [{ id: "delivery-1", state: "unknown" as const }],
          },
        },
      ]) {
        replaceSessionEntrySync(targetScope, original);
        const foreign = { ...original, ...change };
        beforeCommit = () => replaceSessionEntrySync(targetScope, foreign);
        await expect(
          clearPendingFinalDeliveryAfterSuccess(identity, { preserveActivity: true }),
        ).resolves.toBeUndefined();
        const persisted = readEntry();
        if ("label" in change) {
          expect(persisted.label).toBe("foreign metadata");
          expect(persisted.pendingFinalDelivery).toBeUndefined();
          expect(persisted.status).toBe("done");
        } else {
          expect(persisted).toMatchObject(foreign);
          expect(persisted.pendingFinalDelivery).toEqual(foreign.pendingFinalDelivery);
          expect(persisted.status).toBeUndefined();
        }
        expect(persisted.updatedAt).toBe(1);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
