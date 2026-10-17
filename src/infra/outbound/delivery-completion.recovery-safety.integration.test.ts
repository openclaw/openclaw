import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { installQueueTestPlugin } from "./deliver.custody.test-support.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  enqueueDeliveryOnce,
  reserveDeliveryAttempt,
  markDeliveryPlatformSendAttemptStarted,
  markDeliveryPlatformOutcomeUnknown,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("recovered requester receipt safety", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    installQueueTestPlugin();
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  function recovery(
    send: NonNullable<Parameters<typeof deliverOutboundPayloads>[0]["deps"]>["matrix"],
  ) {
    return () =>
      recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir,
        log: createRecoveryLog(),
        deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: send } }),
      });
  }

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
  const enqueue = ({
    context,
    payloads,
    completion,
  }: Awaited<ReturnType<typeof prepareDelivery>>) =>
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

  async function dispatch(
    mode: string,
    fixture: Awaited<ReturnType<typeof prepareDelivery>>,
    send: NonNullable<Parameters<typeof deliverOutboundPayloads>[0]["deps"]>["matrix"],
    requiredRecovery = false,
  ) {
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

  async function prepare(
    options: {
      refreshSuccessor?: boolean;
      payloads?: Array<{ text: string }>;
      second?: boolean;
    } = {},
  ) {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:receipt-safety",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    const context = { channel: "matrix", to: "!original:example", threadId: "original-thread" };
    await replaceSessionEntry(scope, {
      sessionId: "session",
      lifecycleRevision: "lifecycle-a",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "run-a",
      restartRecoveryDeliverySourceRunId: "source-a",
      restartRecoveryDeliveryContext: context,
    });
    const entry = loadSessionEntry(scope)!;
    const admission = prepareAgentCommandExecutionIdentity({
      opts: { message: "finish the admitted task" },
      prepared: {
        cfg: {},
        runId: "run-a",
        sessionAgentId: "main",
        sessionId: entry.sessionId,
        sessionEntry: entry,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
      },
      ingress: { kind: "system", boundary: "receipt-safety-test", state: "present" },
      lifecycleGeneration: "test-generation",
    });
    const sessionStore = { [scope.sessionKey]: entry };
    if (options.refreshSuccessor) {
      await patchSessionEntryCore(scope, () => ({
        restartRecoveryDeliveryRunId: "run-b",
        restartRecoveryDeliverySourceRunId: "source-b",
      }));
      // Match onCommitted publication: the cached entry and authoritative row both become B.
      Object.assign(sessionStore[scope.sessionKey], loadSessionEntry(scope));
    }
    const payloads = options.payloads ?? [{ text: "final output" }];
    let marker;
    try {
      marker = await persistPendingFinalDeliveryMarker({
        ...scope,
        deliver: true,
        sessionEntry: entry,
        sessionStore,
        admittedRecoverySource: admission.pendingFinalRecoverySource,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: context,
        runOwnedSessionId: entry.sessionId,
      });
    } finally {
      admission.close();
    }
    const completion = resolvePendingFinalDeliveryCompletion(payloads);
    if (options.second) {
      await patchSessionEntryCore(scope, (current) => ({
        pendingFinalDelivery: {
          ...current.pendingFinalDelivery!,
          deliveries: [
            ...current.pendingFinalDelivery!.deliveries!,
            { id: "second", state: "prepared" },
          ],
        },
      }));
    }
    return { scope, context, payloads, marker, completion };
  }

  async function prepareDelivery(options: Parameters<typeof prepare>[0] = {}) {
    const fixture = await prepare(options);
    if (!fixture.completion) {
      throw new Error("missing completion");
    }
    return { ...fixture, completion: fixture.completion };
  }

  it("does not bind finishing A to a refreshed same-session same-route successor B", async () => {
    const { scope, marker } = await prepare({ refreshSuccessor: true });
    expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(false);
    expect(loadSessionEntry(scope)).toMatchObject({
      restartRecoveryDeliveryRunId: "run-b",
      restartRecoveryDeliverySourceRunId: "source-b",
    });
    expect(loadSessionEntry(scope)?.pendingFinalDelivery).toBeUndefined();
  });

  it.each(["missing-identity", "wrong-target", "wrong-channel", "not-sent"] as const)(
    "requires evidence for earlier logical members: %s then valid",
    async (invalid) => {
      const { scope, context, completion } = await prepareDelivery({ second: true });
      const first: OutboundDeliveryResult = {
        channel: invalid === "wrong-channel" ? "discord" : "matrix",
        messageId: invalid === "missing-identity" ? "" : "first",
        target: { kind: "room", id: invalid === "wrong-target" ? "!other:example" : context.to },
        ...(invalid === "not-sent" ? { outcome: "not_sent" as const } : {}),
      };
      await settlePendingFinalDelivery(completion, "delivered", undefined, {
        identifiedResult: first,
      });
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      await settlePendingFinalDelivery(
        { ...completion, deliveryId: "second" },
        "delivered",
        undefined,
        { identifiedResult: { channel: "matrix", messageId: "valid-last" } },
      );
      expect(evidence(scope)).toBeUndefined();
      expect(evidence(scope, "source-b")).toBeUndefined();
    },
  );

  it.each(["recovery", "live"] as const)(
    "does not acknowledge invalid-first valid-last logical sends through %s custody",
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
      const entry = loadSessionEntry(scope);
      expect(entry?.pendingFinalDelivery?.deliveries).toMatchObject([
        { id: completion.deliveryId, state: "delivered" },
        { id: "second", state: "delivered" },
      ]);
      expect(entry?.pendingFinalDelivery?.deliveries?.[0]?.receipt).toBeUndefined();
      expect(getRestartRecoveryTerminalDeliveryEvidence(entry, "source-a")).toBeUndefined();
      expect(entry?.pendingFinalDelivery?.deliveries?.[1]?.receipt).toMatchObject({
        platformMessageId: "second-id",
      });
      await expectDrained(recover, send);
    },
  );

  it.each(
    ["recovery", "live"].flatMap((mode) =>
      [false, true].map((suppressFirst) => ({ mode, suppressFirst })),
    ),
  )(
    "requires all physical command payloads ($mode, partial suppression: $suppressFirst)",
    async ({ mode, suppressFirst }) => {
      const fixture = await prepareDelivery({
        payloads: [{ text: "first" }, { text: "second" }],
      });
      const send = vi.fn(async (_to: string, text: string) =>
        suppressFirst && text === "first"
          ? { messageId: "", outcome: "not_sent" }
          : { messageId: text + "-id" },
      );
      const recover = recovery(send);
      await dispatch(mode, fixture, send);
      expectReceipt(fixture.scope, suppressFirst ? undefined : "second-id", 2);
      await expectDrained(recover, send);
    },
  );

  it.each([
    "nested-target",
    "mixed-parts",
    "receipt-thread",
    "part-thread",
    "matching",
    "normalized",
    "metadata-omitted",
  ] as const)("validates physical receipt routing through queue delivery: %s", async (variant) => {
    const fixture = await prepareDelivery();
    const { scope, context } = fixture;
    const roomId = variant === "normalized" ? `  ${context.to}  ` : context.to;
    const part = {
      platformMessageId: "first-id",
      kind: "text" as const,
      index: 0,
      threadId: variant === "part-thread" ? "other-thread" : context.threadId,
      raw: { roomId },
    };
    const parts =
      variant === "mixed-parts"
        ? [
            part,
            { ...part, platformMessageId: "other-id", index: 1, raw: { roomId: "!other:example" } },
          ]
        : [part];
    const receipt = {
      primaryPlatformMessageId: "first-id",
      platformMessageIds: parts.map((item) => item.platformMessageId),
      parts,
      threadId: variant === "receipt-thread" ? "other-thread" : context.threadId,
      sentAt: 1,
      raw: [{ roomId: variant === "nested-target" ? "!other:example" : roomId }],
    };
    await enqueue(fixture);
    const send = vi
      .fn()
      .mockResolvedValue(
        variant === "metadata-omitted"
          ? { messageId: "first-id" }
          : { messageId: "first-id", target: { kind: "room", id: context.to }, receipt },
      );
    const recover = recovery(send);
    await recover();
    const valid =
      variant === "matching" || variant === "normalized" || variant === "metadata-omitted";
    expectReceipt(scope, valid ? "first-id" : undefined);
    await expectDrained(recover, send, 1);
  });
  it.each([1, 2])(
    "does not infer complete physical batches from reconciliation (%s payloads)",
    async (count) => {
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
      const recover = () =>
        recoverPendingDeliveries({ cfg: {}, stateDir: tmpDir, log: createRecoveryLog(), deliver });
      await recover();
      expectReceipt(fixture.scope, count === 1 ? "reconciled-id" : undefined);
      expect(deliver).not.toHaveBeenCalled();
      await expectDrained(recover, reconcile, 1);
      expect(deliver).not.toHaveBeenCalled();
    },
  );
});
