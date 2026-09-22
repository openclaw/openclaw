import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import { clearPendingFinalDeliveryAfterSuccess } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
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

  it.each(["global", "unknown"])(
    "retains the selected owner through a queued %s final and settlement",
    async (sessionKey) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
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

      const results = await deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads,
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: completion.deliveryId,
        deliveryCompletion: completion,
      });
      expect(results).toMatchObject([{ messageId: "ops-final-message" }]);
      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(loadSessionEntry(ops)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "delivered" },
      ]);
      await clearPendingFinalDeliveryAfterSuccess(completion);
      expect(loadSessionEntry(ops)?.pendingFinalDelivery).toBeUndefined();
      expect(loadSessionEntry(main)).toEqual(mainBefore);
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );

  it("recovers an older serialized completion with its original locator semantics", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sessionKey = "global";
    const storePath = path.join(tmpDir, "sessions.json");
    const completion = {
      kind: "pending-final" as const,
      deliveryId: "legacy-delivery",
      intentId: "legacy-intent",
      sessionId: "legacy-session",
      sessionKey,
      storePath,
    };
    const entry = {
      sessionId: completion.sessionId,
      updatedAt: 1,
      pendingFinalDelivery: {
        kind: "replayable" as const,
        text: "legacy final",
        createdAt: 1,
        intentId: completion.intentId,
        deliveries: [{ id: completion.deliveryId, state: "prepared" as const }],
      },
    };
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

  it.each(["missing-owner", "conflicting-writer"])(
    "does not fall back from an explicit pending-final owner (%s)",
    async (mismatch) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const sessionKey = "global";
      const storePath = path.join(tmpDir, "sessions.json");
      const completion = {
        kind: "pending-final" as const,
        agentId: "ops",
        deliveryId: "owned-delivery",
        intentId: "owned-intent",
        sessionId: "owned-session",
        sessionKey,
        storePath,
      };
      const entry = {
        sessionId: completion.sessionId,
        updatedAt: 1,
        pendingFinalDelivery: {
          kind: "replayable" as const,
          text: "owned final",
          createdAt: 1,
          intentId: completion.intentId,
          deliveries: [{ id: completion.deliveryId, state: "prepared" as const }],
        },
      };
      await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
      await replaceSessionEntry({ agentId: "ops", sessionKey, storePath }, entry);
      const result = await settlePendingFinalDelivery(
        mismatch === "missing-owner"
          ? { ...completion, agentId: "other" }
          : {
              ...completion,
              sessionWriterDeliveryAuthority: {
                agentId: "main",
                expectedSessionId: completion.sessionId,
                sessionKey,
                storePath,
              },
            },
        "delivered",
      );
      expect(result).toEqual({ state: "stale" });
      for (const agentId of ["main", "ops"]) {
        expect(loadSessionEntry({ agentId, sessionKey, storePath })?.pendingFinalDelivery).toEqual(
          entry.pendingFinalDelivery,
        );
      }
    },
  );

  it("keeps a shared SQLite schema owner distinct from the final's logical owner", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const storePath = path.join(tmpDir, "shared.sqlite");
    const completion = {
      kind: "pending-final" as const,
      agentId: "ops",
      deliveryId: "shared-delivery",
      intentId: "shared-intent",
      sessionId: "shared-session",
      sessionKey: "global",
      storePath,
      sessionWriterDeliveryAuthority: {
        agentId: "ops",
        expectedSessionId: "shared-session",
        sessionKey: "global",
        storePath,
      },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: completion.sessionKey, storePath },
      {
        sessionId: completion.sessionId,
        updatedAt: 1,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "shared final",
          createdAt: 1,
          intentId: completion.intentId,
          deliveries: [{ id: completion.deliveryId, state: "prepared" }],
        },
      },
    );
    await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
      state: "delivered",
    });
    expect(inspectOpenClawAgentDatabaseOwner(storePath)).toEqual({
      status: "owned",
      agentId: "main",
    });
  });

  it("suppresses a second stable caller after the exact pending final was delivered", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sessionKey = "agent:main:matrix:direct:123";
    const storePath = path.join(tmpDir, "sessions.json");
    const deliveryId = "pending-final-delivery-1";
    const completion = {
      kind: "pending-final" as const,
      deliveryId,
      intentId: "pending-final-intent-1",
      sessionId: "session-1",
      sessionKey,
      storePath,
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-1",
        status: "running",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "deliver once",
          createdAt: Date.now(),
          intentId: completion.intentId,
          deliveries: [{ id: deliveryId, state: "prepared" }],
        },
      },
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "matrix-message-1" });
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "deliver once" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId: deliveryId,
      deliveryCompletion: completion,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "matrix-message-1" },
    ]);
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery?.deliveries).toEqual([
      { id: deliveryId, state: "delivered" },
    ]);

    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it("keeps an uncertainty notice owed when a live send returns no delivery identity", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sessionKey = "agent:main:matrix:direct:unknown-live";
    const storePath = path.join(tmpDir, "sessions.json");
    const deliveryId = "pending-final-unknown-live";
    const completion = {
      kind: "pending-final" as const,
      deliveryId,
      intentId: "pending-final-intent-unknown-live",
      sessionId: "session-unknown-live",
      sessionKey,
      storePath,
    };
    const context = { channel: "matrix", to: "!room:example" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: completion.sessionId,
        status: "running",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "delivery identity may have been lost",
          context,
          createdAt: Date.now(),
          intentId: completion.intentId,
          deliveries: [{ id: deliveryId, state: "prepared" }],
        },
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
