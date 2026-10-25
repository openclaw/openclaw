import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { installQueueTestPlugin, useOutboundFixture } from "./deliver.custody.test-support.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { markFinal, seedRecoverySession } from "./delivery-completion.shard-test-support.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  enqueueDeliveryOnce,
  reserveDeliveryAttempt,
  markDeliveryPlatformSendAttemptStarted,
  markDeliveryPlatformOutcomeUnknown,
} from "./delivery-queue-storage.js";
import { createRecoveryLog, loadPendingDeliveries } from "./delivery-queue.test-helpers.js";

const outbound = useOutboundFixture();
const deliverOutboundPayloads = outbound.deliver;
type Send = NonNullable<Parameters<typeof deliverOutboundPayloads>[0]["deps"]>["matrix"];

describe("recovered requester receipt safety", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = outbound.tmpDir();
    installQueueTestPlugin();
  });

  const recovery =
    (
      send: Send,
      deliver: Parameters<typeof recoverPendingDeliveries>[0]["deliver"] = (params) =>
        deliverOutboundPayloads({ ...params, deps: { matrix: send } }),
    ) =>
    () =>
      recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir,
        log: createRecoveryLog(),
        deliver,
      });

  const evidence = (scope: Parameters<typeof loadSessionEntry>[0], source = "source-a") =>
    getRestartRecoveryTerminalDeliveryEvidence(loadSessionEntry(scope), source);
  function expectReceipt(
    scope: Parameters<typeof loadSessionEntry>[0],
    messageId?: string,
    resultCount?: number,
  ) {
    if (!messageId) {
      expect(evidence(scope)).toBeUndefined();
    } else {
      expect(evidence(scope)).toMatchObject({
        durableFinalReceipt: { platformMessageId: messageId },
        ...(resultCount === undefined ? {} : { deliveryStatus: { status: "sent", resultCount } }),
      });
    }
  }
  type Fixture = Awaited<ReturnType<typeof prepareDelivery>>;
  const enqueue = ({ context, payloads, completion }: Fixture) =>
    enqueueDeliveryOnce(
      { ...context, payloads, deliveryCompletion: completion },
      completion.deliveryId,
      tmpDir,
    );

  async function expectDrained(
    recover: () => Promise<unknown>,
    send: ReturnType<typeof vi.fn>,
    calls = 2,
  ) {
    await recover();
    expect(send).toHaveBeenCalledTimes(calls);
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  }

  async function dispatch(mode: string, fixture: Fixture, send: Send, requiredRecovery = false) {
    const params = {
      cfg: {},
      ...fixture.context,
      payloads: fixture.payloads,
      deliveryCompletion: fixture.completion,
      deliveryIntentId: fixture.completion.deliveryId,
      queuePolicy: mode === "live" || requiredRecovery ? ("required" as const) : undefined,
      deps: { matrix: send },
    };
    if (mode === "live") {
      await deliverOutboundPayloads(params);
    } else {
      await enqueueDeliveryOnce(params, fixture.completion.deliveryId, tmpDir);
      await recovery(send)();
    }
  }

  async function prepareDelivery(
    options: {
      payloads?: Array<{ text: string }>;
      second?: boolean;
    } = {},
  ) {
    const payloads = options.payloads ?? [{ text: "final output" }];
    const context = { channel: "matrix", to: "!original:example", threadId: "original-thread" };
    const { scope, entry } = await seedRecoverySession(tmpDir, "source-a", "run-a", {
      lifecycleRevision: "lifecycle-a",
      restartRecoveryDeliveryContext: context,
    });
    await markFinal(scope, entry, payloads, context);
    const completion = resolvePendingFinalDeliveryCompletion(payloads);
    if (!completion) {
      throw new Error("missing completion");
    }
    if (options.second) {
      await patchSessionEntryCore(scope, ({ pendingFinalDelivery }) => ({
        pendingFinalDelivery: {
          ...pendingFinalDelivery!,
          deliveries: [...pendingFinalDelivery!.deliveries!, { id: "second", state: "prepared" }],
        },
      }));
    }
    return { scope, context, payloads, completion };
  }

  it.each(["missing-identity", "wrong-channel", "not-sent"] as const)(
    "requires evidence for earlier logical members: %s then valid",
    async (invalid) => {
      const { scope, context, completion } = await prepareDelivery({ second: true });
      const settle = (identifiedResult: OutboundDeliveryResult, id = completion.deliveryId) =>
        settlePendingFinalDelivery({ ...completion, deliveryId: id }, "delivered", undefined, {
          identifiedResult,
        });
      const first: OutboundDeliveryResult = {
        channel: invalid === "wrong-channel" ? "discord" : "matrix",
        messageId: invalid === "missing-identity" ? "" : "first",
        target: { kind: "room", id: context.to },
        ...(invalid === "not-sent" ? { outcome: "not_sent" as const } : {}),
      };
      await settle(first);
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      await settle({ channel: "matrix", messageId: "valid-last" }, "second");
      expect([evidence(scope), evidence(scope, "source-b")]).toEqual([undefined, undefined]);
    },
  );

  it.each(["recovery", "live"] as const)(
    "rejects invalid-first valid-last logical sends through %s custody",
    async (mode) => {
      const fixture = await prepareDelivery({ second: true });
      const { scope, context, completion } = fixture;
      const send = vi.fn(async (_to: string, text: string) => ({
        messageId: text + "-id",
        target: { kind: "room", id: text === "first" ? "!other:example" : context.to },
      }));
      const recover = recovery(send);
      for (const [text, deliveryId] of [
        ["first", completion.deliveryId],
        ["second", "second"],
      ] as const) {
        await dispatch(
          mode,
          { ...fixture, payloads: [{ text }], completion: { ...completion, deliveryId } },
          send,
          true,
        );
        await closeOpenClawAgentDatabasesAsync(tmpDir);
      }
      const deliveries = loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries;
      expect(deliveries).toMatchObject([
        { id: completion.deliveryId, state: "delivered" },
        { id: "second", state: "delivered", receipt: { platformMessageId: "second-id" } },
      ]);
      expect(deliveries?.[0]?.receipt).toBeUndefined();
      expect(evidence(scope)).toBeUndefined();
      await expectDrained(recover, send);
    },
  );

  it.each(
    ["recovery", "live"].flatMap((mode) =>
      [false, true].map((suppressed) => ({ mode, suppressed })),
    ),
  )(
    "requires every physical payload ($mode, suppressed: $suppressed)",
    async ({ mode, suppressed }) => {
      const fixture = await prepareDelivery({ payloads: [{ text: "first" }, { text: "second" }] });
      const send = vi.fn(async (_to: string, text: string) =>
        suppressed && text === "first"
          ? { messageId: "", outcome: "not_sent" }
          : { messageId: text + "-id" },
      );
      const recover = recovery(send);
      await dispatch(mode, fixture, send);
      expectReceipt(fixture.scope, suppressed ? undefined : "second-id", 2);
      await expectDrained(recover, send);
    },
  );

  // Per-field placement and normalization are covered by delivery-completion.progress-evidence;
  // keep the final-only aggregate boundary here: one valid part cannot bless a misrouted part.
  it.each([false, true])("validates mixed physical receipt routing: %s", async (mixed) => {
    const fixture = await prepareDelivery();
    const { scope, context } = fixture;
    const part = {
      platformMessageId: "first-id",
      kind: "text" as const,
      index: 0,
      threadId: context.threadId,
      raw: { roomId: context.to },
    };
    const parts = mixed
      ? [
          part,
          { ...part, platformMessageId: "other-id", index: 1, raw: { roomId: "!other:example" } },
        ]
      : [part];
    const receipt = {
      primaryPlatformMessageId: "first-id",
      platformMessageIds: parts.map((item) => item.platformMessageId),
      parts,
      threadId: context.threadId,
      sentAt: 1,
      raw: [{ roomId: context.to }],
    };
    await enqueue(fixture);
    const send = vi.fn(async () => ({
      messageId: "first-id",
      target: { kind: "room", id: context.to },
      receipt,
    }));
    const recover = recovery(send);
    await recover();
    expectReceipt(scope, mixed ? undefined : "first-id");
    await expectDrained(recover, send, 1);
  });
  it.each([1, 2])("reconciliation cannot imply a complete batch (%s payloads)", async (count) => {
    const fixture = await prepareDelivery({
      payloads: Array.from({ length: count }, (_, index) => ({ text: "part-" + index })),
    });
    const reconcile = vi.fn(async () => ({
      status: "sent" as const,
      receipt: {
        primaryPlatformMessageId: "reconciled-id",
        platformMessageIds: ["reconciled-id"],
        parts: [{ platformMessageId: "reconciled-id", kind: "text" as const, index: 0 }],
        sentAt: 1,
      },
    }));
    installQueueTestPlugin({
      message: {
        id: "matrix",
        send: {
          text: async () => {
            throw new Error("reconciliation must not send again");
          },
        },
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend: reconcile,
        },
      },
    });
    await enqueue(fixture);
    await reserveDeliveryAttempt(fixture.completion.deliveryId, 1, tmpDir);
    await markDeliveryPlatformSendAttemptStarted(fixture.completion.deliveryId, tmpDir);
    await markDeliveryPlatformOutcomeUnknown(fixture.completion.deliveryId, tmpDir);
    const deliver = vi.fn(async () => []);
    const recover = recovery(undefined, deliver);
    await recover();
    expectReceipt(fixture.scope, count === 1 ? "reconciled-id" : undefined);
    await expectDrained(recover, reconcile, 1);
    expect(deliver).not.toHaveBeenCalled();
  });
});
