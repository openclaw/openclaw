import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { inspectOpenClawAgentDatabaseOwner } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("pending-final durable delivery completion", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function pendingFinal(
    name: string,
    text: string,
    sessionKey = "global",
    store = "sessions.json",
  ) {
    const completion = {
      kind: "pending-final" as const,
      deliveryId: `${name}-delivery`,
      intentId: `${name}-intent`,
      sessionId: `${name}-session`,
      sessionKey,
      storePath: path.join(tmpDir, store),
    };
    return {
      completion,
      entry: {
        sessionId: completion.sessionId,
        updatedAt: 1,
        pendingFinalDelivery: {
          kind: "replayable" as const,
          text,
          createdAt: 1,
          intentId: completion.intentId,
          deliveries: [{ id: completion.deliveryId, state: "prepared" as const }],
        },
      },
    };
  }

  it.each(["global", "unknown"])(
    "retains the selected owner through a queued %s final, settlement, and repeat suppression",
    async (sessionKey) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const main = { agentId: "main", sessionKey, storePath };
      const ops = { agentId: "ops", sessionKey, storePath };
      await replaceSessionEntry(main, { sessionId: "main-session", updatedAt: 1, label: "main" });
      await replaceSessionEntry(ops, { sessionId: "ops-session", updatedAt: 1, label: "ops" });
      const mainBefore = loadSessionEntry(main);
      const entry = loadSessionEntry(ops);
      if (!entry) {
        throw new Error("Expected the selected agent's session");
      }
      const payloads = [{ text: "the selected agent's final" }];
      const marker = await persistPendingFinalDeliveryMarker({
        agentId: "ops",
        deliver: true,
        sessionStore: { [sessionKey]: entry },
        sessionKey,
        sessionEntry: entry,
        storePath,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: { channel: "matrix", to: "!room:example" },
        runOwnedSessionId: entry.sessionId,
      });
      expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      if (!completion) {
        throw new Error("Expected a durable completion from the marker");
      }
      const sendMatrix = vi.fn(async () => {
        expect((await loadPendingDeliveries(tmpDir))[0]?.deliveryCompletion).toMatchObject({
          agentId: "ops",
          sessionId: "ops-session",
          sessionKey,
        });
        return { messageId: "ops-final-message" };
      });

      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
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
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
      await clearPendingFinalDeliveryAfterSuccess(completion);
      expect(loadSessionEntry(ops)?.pendingFinalDelivery).toBeUndefined();
      expect(loadSessionEntry(main)).toEqual(mainBefore);
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );

  it("retains the writer in queued custody after a channel transforms a direct final", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:matrix:direct:rendered-final",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    const authority = {
      ...scope,
      expectedSessionId: "rendered-session",
      expectedLifecycleRevision: "rendered-revision",
      expectedWriterRunId: "rendered-writer",
    };
    await replaceSessionEntry(scope, {
      sessionId: authority.expectedSessionId,
      lifecycleRevision: authority.expectedLifecycleRevision,
      activeWriterRunId: authority.expectedWriterRunId,
      updatedAt: 1,
    });
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error("Expected the direct delivery session");
    }
    const payload = setReplyPayloadMetadata(
      { text: "original final" },
      { sessionWriterDeliveryAuthority: authority },
    );
    await persistPendingFinalDeliveryMarker({
      ...scope,
      deliver: true,
      sessionStore: { [scope.sessionKey]: entry },
      sessionEntry: entry,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads: [payload],
      deliveryContext: { channel: "matrix", to: "!room:example" },
      runOwnedSessionId: entry.sessionId,
    });
    const custody = createDirectPendingFinalCustody(payload, scope.storePath);
    const completion = resolvePendingFinalDeliveryCompletion([payload]);
    if (!custody || !completion) {
      throw new Error("Expected direct custody and its durable pending final");
    }
    let queuedAuthority: SessionWriterDeliveryAuthority | undefined;
    const sendMatrix = vi.fn(async () => {
      const queued = (await loadPendingDeliveries(tmpDir))[0]?.deliveryCompletion;
      queuedAuthority =
        queued?.kind === "pending-final" ? queued.sessionWriterDeliveryAuthority : undefined;
      return { messageId: "rendered-final-message" };
    });
    const rendered = custody.bindPendingFinalDelivery?.({ text: "channel-rendered final" });
    if (!rendered) {
      throw new Error("Expected the direct owner to bind the rendered payload");
    }

    const result = await sendDurableMessageBatchCore({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
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
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it("recovers an older serialized completion with its original locator semantics", async () => {
    const { completion, entry } = pendingFinal("legacy", "legacy final");
    const { sessionKey, storePath } = completion;
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
    await replaceSessionEntry({ agentId: "ops", sessionKey, storePath }, entry);
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "legacy final" }],
        deliveryCompletion: completion,
      },
      completion.deliveryId,
      tmpDir,
    );
    expect((await loadPendingDeliveries(tmpDir))[0]?.deliveryCompletion).not.toHaveProperty(
      "agentId",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "legacy-message" });
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir,
      log: createRecoveryLog(),
      deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    });

    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath })?.pendingFinalDelivery
        ?.deliveries,
    ).toEqual([{ id: completion.deliveryId, state: "delivered" }]);
    expect(
      loadSessionEntry({ agentId: "ops", sessionKey, storePath })?.pendingFinalDelivery,
    ).toEqual(entry.pendingFinalDelivery);
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it.each([
    {
      owner: "missing-owner",
      store: "sessions.json",
      agentId: "other",
      writer: undefined,
      state: "stale",
    },
    {
      owner: "conflicting-writer",
      store: "sessions.json",
      agentId: "ops",
      writer: "main",
      state: "stale",
    },
    {
      owner: "shared-schema-owner",
      store: "shared.sqlite",
      agentId: "ops",
      writer: "ops",
      state: "delivered",
    },
  ] as const)(
    "settles only the logical pending-final owner: $owner",
    async ({ store, agentId, writer, state }) => {
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
    const context = { channel: "matrix", to: "!room:example" };
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

    try {
      await expect(
        deliverOutboundPayloads({
          cfg: {} as OpenClawConfig,
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "delivery identity may have been lost" }],
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
          deliveryIntentId: deliveryId,
          deliveryCompletion: completion,
        }),
      ).resolves.toEqual([]);
    } finally {
      unsubscribe();
    }

    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
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
