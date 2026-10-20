import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import {
  setReplyPayloadMetadata,
  type SessionWriterDeliveryAuthority,
} from "../../auto-reply/reply-payload.js";
import { clearPendingFinalDeliveryAfterSuccess } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import { createDirectPendingFinalCustody } from "../../channels/turn/direct-delivery-custody.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { inspectOpenClawAgentDatabaseOwner } from "../../state/openclaw-agent-db.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  createPendingFinalFixture,
  loadPendingDeliveries,
  installDeliveryCompletionHooks,
} from "./delivery-queue.test-helpers.js";

describe("pending-final durable delivery completion", () => {
  const { tmpDir, deliver: deliverOutboundPayloads } = installDeliveryCompletionHooks(true);
  const destination = { channel: "matrix", to: "!room:example" } as const;

  function pendingFinal(
    name: string,
    text: string,
    sessionKey = "global",
    store = "sessions.json",
  ) {
    return createPendingFinalFixture(path.join(tmpDir(), store), `${name}-delivery`, sessionKey, {
      text,
    });
  }
  async function prepareWriter(name: string) {
    const scope = {
      agentId: "main",
      sessionKey: `agent:main:matrix:direct:${name}`,
      storePath: path.join(tmpDir(), "sessions.json"),
    };
    const entry = {
      sessionId: `${name}-session`,
      lifecycleRevision: `${name}-revision`,
      activeWriterRunId: `${name}-writer`,
      updatedAt: 1,
    };
    const authority = {
      ...scope,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision,
      expectedWriterRunId: entry.activeWriterRunId,
    };
    await replaceSessionEntry(scope, entry);
    return { scope, entry, authority };
  }
  function markFinal(
    scope: { agentId: string; sessionKey: string; storePath: string },
    entry: NonNullable<ReturnType<typeof loadSessionEntry>>,
    payloads: Parameters<typeof persistPendingFinalDeliveryMarker>[0]["payloads"],
  ) {
    return persistPendingFinalDeliveryMarker({
      ...scope,
      sessionEntry: entry,
      sessionStore: { [scope.sessionKey]: entry },
      payloads,
      deliver: true,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      deliveryContext: destination,
      runOwnedSessionId: entry.sessionId,
    });
  }

  it.each(["global", "unknown"])(
    "retains the selected owner through a queued %s final, settlement, and repeat suppression",
    async (sessionKey) => {
      const storePath = path.join(tmpDir(), "sessions.json");
      const main = { agentId: "main", sessionKey, storePath };
      const ops = { agentId: "ops", sessionKey, storePath };
      await replaceSessionEntry(main, { sessionId: "main-session", updatedAt: 1, label: "main" });
      await replaceSessionEntry(ops, { sessionId: "ops-session", updatedAt: 1, label: "ops" });
      const mainBefore = loadSessionEntry(main);
      const entry = loadSessionEntry(ops);
      assert(entry, "Expected the selected agent's session");
      const payloads = [{ text: "the selected agent's final" }];
      const marker = await markFinal(ops, entry, payloads);
      expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      assert(completion, "Expected a durable completion from the marker");
      const sendMatrix = vi.fn(async () => {
        expect((await loadPendingDeliveries(tmpDir()))[0]?.deliveryCompletion).toMatchObject({
          agentId: "ops",
          sessionId: "ops-session",
          sessionKey,
        });
        return { messageId: "ops-final-message" };
      });
      const params = {
        cfg: {},
        ...destination,
        payloads,
        deps: { matrix: sendMatrix },
        queuePolicy: "required" as const,
        deliveryIntentId: completion.deliveryId,
        deliveryCompletion: completion,
      } satisfies Parameters<typeof deliverOutboundPayloads>[0];
      const results = await deliverOutboundPayloads(params);
      expect(results).toMatchObject([{ messageId: "ops-final-message" }]);
      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(loadSessionEntry(ops)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "delivered" },
      ]);
      await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
      await clearPendingFinalDeliveryAfterSuccess(completion);
      expect(loadSessionEntry(ops)?.pendingFinalDelivery).toBeUndefined();
      expect(loadSessionEntry(main)).toEqual(mainBefore);
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
    },
  );

  it("retains the writer in queued custody after a channel transforms a direct final", async () => {
    const { scope, entry, authority } = await prepareWriter("rendered-final");
    const payload = setReplyPayloadMetadata(
      { text: "original final" },
      { sessionWriterDeliveryAuthority: authority },
    );
    await markFinal(scope, entry, [payload]);
    const custody = await createDirectPendingFinalCustody(payload, scope.storePath);
    const completion = resolvePendingFinalDeliveryCompletion([payload]);
    if (!custody || !completion) {
      throw new Error("Expected direct custody and its durable pending final");
    }
    let queuedAuthority: SessionWriterDeliveryAuthority | undefined;
    const sendMatrix = vi.fn(async () => {
      const queued = (await loadPendingDeliveries(tmpDir()))[0]?.deliveryCompletion;
      queuedAuthority =
        queued?.kind === "pending-final" ? queued.sessionWriterDeliveryAuthority : undefined;
      return { messageId: "rendered-final-message" };
    });
    const rendered = custody.bindPendingFinalDelivery?.({ text: "channel-rendered final" });
    assert(rendered, "Expected the direct owner to bind the rendered payload");
    const result = await sendDurableMessageBatchCore({
      cfg: {},
      ...destination,
      payloads: [rendered],
      onPlatformSendDispatch: custody.onPlatformSendDispatch,
      assertDirectAdapterHandoff: custody.assertPlatformSendAuthorized,
      deps: { matrix: sendMatrix },
    });
    expect(result.status).toBe("sent");
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(queuedAuthority).toEqual(authority);
    expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries).toEqual([
      { id: completion.deliveryId, state: "delivered" },
    ]);
    expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
    custody.release();
  });

  it("revokes prepared direct delivery after a writer commit without host SQL", async () => {
    const { scope, entry, authority } = await prepareWriter("replaced-writer");
    const sql = observeHostDataSql();
    const custody = await createDirectPendingFinalCustody(
      setReplyPayloadMetadata({ text: "final" }, { sessionWriterDeliveryAuthority: authority }),
    );
    try {
      expect(sql.queries).toEqual([]);
      expect(custody).toBeDefined();
      expect(() => custody!.assertPlatformSendAuthorized()).not.toThrow();
      sql.restore();
      await replaceSessionEntry(scope, {
        ...entry,
        activeWriterRunId: "replacement",
        updatedAt: 2,
      });
      const afterCommit = observeHostDataSql();
      try {
        expect(() => custody!.assertPlatformSendAuthorized()).toThrow(
          "Session writer changed before final reply delivery",
        );
        expect(afterCommit.queries).toEqual([]);
      } finally {
        afterCommit.restore();
      }
    } finally {
      sql.restore();
      custody?.release();
    }
  });

  it("recovers an older serialized completion with its original locator semantics", async () => {
    const { completion, entry } = pendingFinal("legacy", "legacy final");
    const { sessionKey, storePath } = completion;
    const main = { agentId: "main", sessionKey, storePath };
    const ops = { agentId: "ops", sessionKey, storePath };
    await replaceSessionEntry(main, entry);
    await replaceSessionEntry(ops, entry);
    await enqueueDeliveryOnce(
      {
        ...destination,
        payloads: [{ text: "legacy final" }],
        deliveryCompletion: completion,
      },
      completion.deliveryId,
      tmpDir(),
    );
    expect((await loadPendingDeliveries(tmpDir()))[0]?.deliveryCompletion).not.toHaveProperty(
      "agentId",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "legacy-message" });
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
      deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    });
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(loadSessionEntry(main)?.pendingFinalDelivery?.deliveries).toEqual([
      { id: completion.deliveryId, state: "delivered" },
    ]);
    expect(loadSessionEntry(ops)?.pendingFinalDelivery).toEqual(entry.pendingFinalDelivery);
    expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
  });

  it.each([
    ["missing-owner", "sessions.json", "other", undefined, "stale"],
    ["conflicting-writer", "sessions.json", "ops", "main", "stale"],
    ["shared-schema-owner", "shared.sqlite", "ops", "ops", "delivered"],
  ] as const)(
    "settles only the logical pending-final owner: %s",
    async (_owner, store, agentId, writer, state) => {
      const { completion, entry } = pendingFinal("owned", "owned final", "global", store);
      const { sessionKey, storePath } = completion;
      await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
      if (state === "stale") {
        await replaceSessionEntry({ agentId: "ops", sessionKey, storePath }, entry);
      }
      await expect(
        settlePendingFinalDelivery(
          {
            ...completion,
            agentId,
            ...(writer
              ? {
                  sessionWriterDeliveryAuthority: {
                    agentId: writer,
                    expectedSessionId: completion.sessionId,
                    sessionKey,
                    storePath,
                  },
                }
              : {}),
          },
          "delivered",
        ),
      ).resolves.toEqual({ state });
      if (state === "stale") {
        for (const ownerId of ["main", "ops"]) {
          expect(
            loadSessionEntry({ agentId: ownerId, sessionKey, storePath })?.pendingFinalDelivery,
          ).toEqual(entry.pendingFinalDelivery);
        }
      } else {
        expect(inspectOpenClawAgentDatabaseOwner(storePath)).toEqual({
          status: "owned",
          agentId: "main",
        });
      }
    },
  );

  it("keeps an uncertainty notice owed when a live send returns no delivery identity", async () => {
    const { completion, entry } = pendingFinal(
      "unknown-live",
      "delivery identity may have been lost",
      "agent:main:matrix:direct:unknown-live",
    );
    const { sessionKey, storePath, deliveryId } = completion;
    const context = destination;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        updatedAt: Date.now(),
        pendingFinalDelivery: { ...entry.pendingFinalDelivery, context, createdAt: Date.now() },
      },
    );
    const sendMatrix = vi.fn().mockResolvedValue({});
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    await expect(
      deliverOutboundPayloads({
        cfg: {},
        ...destination,
        payloads: [{ text: "delivery identity may have been lost" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: deliveryId,
        deliveryCompletion: completion,
      }),
    ).resolves.toEqual([]);
    unsubscribe();
    expect((await loadPendingDeliveries(tmpDir()))[0]).toMatchObject({
      id: deliveryId,
      recoveryState: "unknown_after_send",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      pendingFinalDelivery: {
        deliveries: [{ id: deliveryId, state: "unknown" }],
      },
      pendingDeliveryNotice: {
        intentId: completion.intentId,
        state: "owed",
        context,
      },
    });
    expect(auditEvents.map((event) => event.outcome)).toEqual(["queued", "platform_started"]);
    expect(auditEvents).not.toContainEqual(
      expect.objectContaining({ action: "message.outbound.finished" }),
    );
  });
});
