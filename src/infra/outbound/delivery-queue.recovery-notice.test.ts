import path from "node:path";
import { expect, it, vi } from "vitest";
import { markConversationDeliverySent } from "../../config/sessions/conversation-delivery-store.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createRecoveryNoticeFixture,
  recoveryNoticeDestination,
  recoveryNoticeText,
} from "../../sessions/recovery-notice.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import { createConversationRecoveryFixture } from "./delivery-queue.conversation-test-helpers.js";
import { createRecoveryLog } from "./delivery-queue.test-helpers.js";

it.each([
  ["fresh", "local"],
  ["fresh", "receipt-thread"],
  ["fresh", "receipt-conflict"],
  ["fresh", "receipt-root-conflict"],
  ["fresh", "adopted-pending"],
  ["accepted", "local"],
  ["accepted", "changed-text"],
  ["accepted", "pending"],
  ["accepted", "rebound"],
  ["accepted", "wrong-thread"],
  ["accepted", "changed-binding"],
  ["reconciled", "local"],
  ["reconciled", "receipt-thread"],
  ["reconciled", "receipt-conflict"],
  ["reconciled", "receipt-root-conflict"],
  ["reconciled", "pending"],
] as const)("keeps %s recovery notice custody through reopen (%s)", async (acceptance, state) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const originalStore = path.join(stateDir, "original", "sessions.json");
    const replacementStore = path.join(stateDir, "replacement", "sessions.json");
    const destination = {
      ...recoveryNoticeDestination,
      threadId: state === "receipt-root-conflict" || state === "adopted-pending" ? undefined : 42,
    };
    const fixture = await createRecoveryNoticeFixture(
      originalStore,
      !state.includes("pending"),
      destination,
    );
    const { generation, provenance, producer, entry } = fixture;
    const operationId = `notice-${acceptance}-${state}`;
    const text =
      state === "changed-text" ? `${recoveryNoticeText} Channel annotation.` : recoveryNoticeText;
    const queued = {
      ...destination,
      payloads: [{ text }],
      threadId: state === "wrong-thread" ? 43 : destination.threadId == null ? undefined : "42",
      session: producer,
      sessionGeneration: generation,
      transcriptProvenance: provenance,
      preparedBatch: {
        schemaVersion: 1,
        sourcePayloadCount: 1,
        channelNormalized: true,
        entries: [
          {
            status: "accepted",
            sourceIndex: 0,
            payload: { text },
            replyHookChanged: false,
            messageHookChanged: false,
            preparedMediaCount: 0,
          },
        ],
      },
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"], text, mediaUrls: [] }],
      },
    } satisfies Parameters<typeof enqueueDeliveryOnce>[0];
    if (acceptance === "accepted") {
      const receiptScope = await createConversationRecoveryFixture({
        operationId,
        stateDir,
        delivery: queued,
      });
      await markConversationDeliverySent(receiptScope, operationId, "accepted-platform-message");
    } else {
      await enqueueDeliveryOnce(queued, operationId, stateDir);
      if (acceptance === "reconciled") {
        await markDeliveryPlatformSendAttemptStarted(operationId, stateDir);
        await markDeliveryPlatformOutcomeUnknown(operationId, stateDir);
      }
    }
    // Identical logical identity in the new configured store cannot inherit old queue custody.
    await replaceSessionEntry({ ...generation, storePath: replacementStore }, entry);
    const other = {
      ...generation,
      sessionKey: "agent:secondary:dashboard:other",
      sessionId: "other-session",
    };
    await replaceSessionEntry(other, {
      ...entry,
      sessionId: other.sessionId,
      mainRestartRecovery: undefined,
    });
    await replaceSessionEntry(generation, {
      ...entry,
      ...(state === "rebound" ? { lifecycleRevision: "replacement" } : {}),
      delivery: normalizeSessionDeliveryState({
        context: { ...recoveryNoticeDestination, to: "reef:moved" },
      }),
    });
    const before = await loadTranscriptEvents(generation);
    await closeStateDatabaseForTest();
    await closeOpenClawAgentDatabasesAsync();
    const registry = captureActivePluginRegistrySnapshot();
    const receipt = {
      platformMessageIds: ["reconciled-message"],
      parts: (state.includes("conflict")
        ? ["42", "43"]
        : [state === "receipt-thread" ? "43" : "42"]
      ).map((threadId, index) => ({
        platformMessageId: `reconciled-message-${index}`,
        kind: "text" as const,
        index,
        threadId,
      })),
      sentAt: 1,
    };
    const sendText = vi.fn(
      async (ctx: {
        onPlatformSendDispatch?: () => Promise<void>;
        assertDirectAdapterHandoff?: () => void;
      }) => {
        await ctx.onPlatformSendDispatch?.();
        ctx.assertDirectAdapterHandoff?.();
        return {
          channel: "reef",
          messageId: "fresh-platform-message",
          receipt: state.startsWith("receipt-")
            ? receipt
            : {
                platformMessageIds: ["fresh-platform-message"],
                parts: [],
                sentAt: 1,
              },
        };
      },
    );
    const reconcileUnknownSend = vi.fn(async () => ({ status: "sent" as const, receipt }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "reef",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "reef",
              outbound: {
                deliveryMode: "direct",
                sendText,
                adoptTargetFromDelivery: () =>
                  state === "adopted-pending" ? { threadId: "43" } : undefined,
              },
            }),
            message: {
              id: "reef",
              send: { text: sendText },
              durableFinal: {
                capabilities: { reconcileUnknownSend: true },
                reconcileUnknownSend,
              },
            },
          },
        },
      ]),
    );
    const log = createRecoveryLog();
    const liveDiagnostic = vi.fn();
    const deliver = vi.fn<typeof deliverOutboundPayloadsInternal>((params, context) =>
      deliverOutboundPayloadsInternal(
        { ...params, onTranscriptDiagnostic: liveDiagnostic },
        context,
      ),
    );
    const recover = () =>
      recoverPendingDeliveries(
        {
          cfg: {
            agents: { ownership: "explicit", entries: { main: {}, secondary: {} } },
            session: { store: replacementStore },
            ...(state === "changed-binding"
              ? {
                  bindings: [{ agentId: "main", match: { channel: "reef", accountId: "default" } }],
                }
              : {}),
          },
          stateDir,
          deliver,
          log,
        },
        deliver,
      );
    try {
      const recovered = await recover();
      expect(
        recovered,
        JSON.stringify({ warnings: log.warn.mock.calls, errors: log.error.mock.calls }),
      ).toMatchObject({ recovered: 1, failed: 0 });
      expect(reconcileUnknownSend).toHaveBeenCalledTimes(acceptance === "reconciled" ? 1 : 0);
      expect(deliver).toHaveBeenCalledTimes(acceptance === "fresh" ? 1 : 0);
      expect(sendText).toHaveBeenCalledTimes(acceptance === "fresh" ? 1 : 0);
      if (acceptance === "fresh") {
        expect(deliver.mock.calls[0]?.[0]).toMatchObject({
          transcriptGeneration: generation,
          session: producer,
          transcriptProvenance: provenance,
        });
        expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("sessionGeneration");
      }
      const after = await loadTranscriptEvents(generation);
      expect(after.slice(0, before.length)).toEqual(before);
      const messages = after
        .map(readTranscriptEventMessage)
        .filter((message) => message?.model === "automation-result");
      if (
        state === "rebound" ||
        state === "wrong-thread" ||
        state.startsWith("receipt-") ||
        state === "adopted-pending"
      ) {
        expect(messages).toEqual([]);
        expect(acceptance === "fresh" ? liveDiagnostic : log.warn).toHaveBeenCalled();
      } else {
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          content: [{ type: "text", text }],
          openclawAutomation: provenance,
        });
        expect(messages[0]?.display === false).toBe(
          state === "local" || state === "changed-binding",
        );
        expect(JSON.stringify(messages)).not.toContain(originalStore);
        if (state === "changed-text") {
          expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("actual text"));
        }
      }
      expect(await loadTranscriptEvents({ ...generation, storePath: replacementStore })).toEqual(
        [],
      );
      expect(await loadTranscriptEvents(other)).toEqual([]);
      await closeStateDatabaseForTest();
      await closeOpenClawAgentDatabasesAsync();
      expect(await recover()).toMatchObject({ recovered: 0, failed: 0 });
      expect(await loadTranscriptEvents(generation)).toEqual(after);
      expect(sendText).toHaveBeenCalledTimes(acceptance === "fresh" ? 1 : 0);
    } finally {
      restoreActivePluginRegistrySnapshot(registry);
      await closeStateDatabaseForTest();
      await closeOpenClawAgentDatabasesAsync();
    }
  });
});
