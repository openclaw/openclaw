import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { capturePendingFinalRecoverySource } from "../../agents/pending-final-recovery-source.js";
import { chunkText } from "../../auto-reply/chunk.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("final receipt physical fanout", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it.each(
    (["live", "recovery"] as const).flatMap((mode) =>
      (["text", "media", "formatted"] as const).flatMap((transport) =>
        (
          [
            "complete",
            "suppressed-first",
            "suppressed-last",
            "unidentified-first",
            "unidentified-last",
          ] as const
        ).map((disposition) => ({ mode, transport, disposition })),
      ),
    ),
  )(
    "requires every physical send in one logical final ($mode, $transport, $disposition)",
    async ({ mode, transport, disposition }) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:physical-fanout",
        storePath: path.join(tmpDir, "sessions.json"),
      };
      const context = { channel: "matrix", to: "!original:example" };
      await replaceSessionEntry(scope, {
        sessionId: "session",
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "run",
        restartRecoveryDeliverySourceRunId: "source",
        restartRecoveryDeliveryContext: context,
      });
      const entry = loadSessionEntry(scope);
      if (!entry) {
        throw new Error("missing fixture session");
      }
      // One logical final. Real core planning splits text or media into two sends.
      const payloads = [
        {
          text: "firstlast",
          ...(transport === "media"
            ? { mediaUrls: ["https://example.test/first.png", "https://example.test/second.png"] }
            : {}),
        },
      ];
      await persistPendingFinalDeliveryMarker({
        ...scope,
        deliver: true,
        sessionEntry: entry,
        sessionStore: { [scope.sessionKey]: entry },
        admittedRecoverySource: capturePendingFinalRecoverySource(entry),
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: context,
        runOwnedSessionId: entry.sessionId,
      });
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      if (!completion) {
        throw new Error("missing final custody");
      }
      let physicalSends = 0;
      const send = vi.fn(async () => {
        const index = physicalSends++;
        const invalid = disposition.endsWith(index === 0 ? "first" : "last");
        return invalid
          ? {
              channel: "matrix",
              messageId: "",
              ...(disposition.startsWith("suppressed") ? { outcome: "not_sent" as const } : {}),
            }
          : { channel: "matrix", messageId: index === 0 ? "first-id" : "second-id" };
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                ...matrixOutboundForQueueTest,
                chunker: chunkText,
                textChunkLimit: 5,
                ...(transport === "formatted"
                  ? {
                      sendFormattedText: async ({ onPlatformSendDispatch }) => {
                        await onPlatformSendDispatch?.();
                        return [await send(), await send()];
                      },
                    }
                  : {}),
              },
            }),
          },
        ]),
      );
      const progress: OutboundDeliveryResult[] = [];
      const runDelivery: typeof deliverOutboundPayloads = (params) =>
        deliverOutboundPayloads({
          ...params,
          deps: { matrix: send },
          onDeliveryResult: async (result) => {
            progress.push(result);
            await params.onDeliveryResult?.(result);
          },
        });
      const recover = () =>
        recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir,
          log: createRecoveryLog(),
          deliver: runDelivery,
        });
      const params = {
        cfg: {},
        ...context,
        payloads,
        deliveryCompletion: completion,
        deliveryIntentId: completion.deliveryId,
        queuePolicy: "required" as const,
      };
      if (mode === "live") {
        await runDelivery(params);
      } else {
        await enqueueDeliveryOnce(params, completion.deliveryId, tmpDir);
        await recover();
      }
      const evidence = getRestartRecoveryTerminalDeliveryEvidence(
        loadSessionEntry(scope),
        "source",
      );
      if (disposition === "complete") {
        expect(evidence).toMatchObject({
          deliveryStatus: { status: "sent", resultCount: 2 },
          durableFinalReceipt: { platformMessageId: "second-id" },
        });
        expect(progress.map((result) => result.messageId)).toEqual(["first-id", "second-id"]);
      } else {
        expect(evidence).toBeUndefined();
        // Receipt refusal must not withhold valid physical progress or retry it.
        expect(progress.map((result) => result.messageId)).toEqual([
          disposition.endsWith("first") ? "second-id" : "first-id",
        ]);
      }
      await recover();
      expect(send).toHaveBeenCalledTimes(2);
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );
});
