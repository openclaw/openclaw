import path from "node:path";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markConversationDeliveryRejected,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as confirmedVisibleMessage from "../../sessions/confirmed-visible-message.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import { createConversationRecoveryFixture as createQueuedConversationRecoveryFixture } from "./delivery-queue.conversation-test-helpers.js";
import {
  RECOVERY_SUMMARY,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
// mock-isolation: Recovery controls only external reconciliation, not plugin discovery.
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));

async function closeConversationAgentDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
function expectMockMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
  expect(mock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(expected);
}
function reconciledSent(messageId: string) {
  return {
    status: "sent",
    messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      sentAt: 1,
    },
  };
}
function installUnknownSendResult(result: Record<string, unknown>) {
  resolveOutboundChannelMessageAdapterMock.mockReturnValue({
    durableFinal: {
      capabilities: { reconcileUnknownSend: true },
      reconcileUnknownSend: vi.fn().mockResolvedValue(result),
    },
  });
}

describe("delivery-queue confirmed transcript recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  afterEach(closeConversationAgentDatabases);
  beforeEach(() => resolveOutboundChannelMessageAdapterMock.mockReset());
  const createConversationRecoveryFixture = (
    operationId: string,
    delivery: Partial<Parameters<typeof enqueueDeliveryOnce>[0]> = {},
    stateDir = tmpDir(),
  ) => createQueuedConversationRecoveryFixture({ operationId, delivery, stateDir });
  async function runRecovery({ deliver }: { deliver: Mock }) {
    const log = createRecoveryLog();
    const result = await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      deliver,
      log,
    });
    return { result, log };
  }
  it.each([
    ["sent", false],
    ["sent", true],
    ["reconciled", false],
    ["reconciled", true],
    ["unresolved", false],
    ["rejected", false],
    ["unnormalized", false],
    ["media", false],
    ["presentation", false],
    ["stale-generation", false],
    ["other-generation", false],
    ["multiple-payloads", false],
  ] as const)(
    "recovers %s transcript with original subset identity (previously committed: %s)",
    async (state, previouslyCommitted) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
        const id = `transcript-recovery-${state}`;
        const payload = { text: "Effective visible result" };
        const scope = await createConversationRecoveryFixture(
          id,
          {
            channel: "telegram",
            to: "group:-100123",
            session: { agentId: "main", key: "agent:main:background-job" },
            sessionGeneration:
              state === "stale-generation" || state === "other-generation"
                ? {
                    agentId: "main",
                    storePath: path.join(stateDir, "agent-sessions.json"),
                    sessionKey:
                      state === "stale-generation"
                        ? "agent:main:telegram:group:-100123"
                        : "agent:main:background-job",
                    sessionId: "old-session",
                    lifecycleRevision: "old-revision",
                  }
                : undefined,
            preparedBatch: {
              schemaVersion: 1,
              sourcePayloadCount: 3,
              channelNormalized: state === "unnormalized" ? undefined : true,
              entries: [
                {
                  status: "accepted",
                  sourceIndex: 2,
                  payload: { text: "Prepared content, not the delivered projection" },
                  replyHookChanged: true,
                  messageHookChanged: false,
                  preparedMediaCount: 0,
                },
                ...(state === "multiple-payloads"
                  ? [
                      {
                        status: "accepted" as const,
                        sourceIndex: 1,
                        payload: { text: "Unconfirmed second payload" },
                        replyHookChanged: false,
                        messageHookChanged: false,
                        preparedMediaCount: 0,
                      },
                    ]
                  : []),
              ],
            },
            renderedBatchPlan: {
              payloadCount: state === "multiple-payloads" ? 2 : 1,
              textCount: state === "multiple-payloads" ? 2 : 1,
              mediaCount: state === "media" ? 1 : 0,
              voiceCount: 0,
              presentationCount: state === "presentation" ? 1 : 0,
              interactiveCount: 0,
              channelDataCount: 0,
              items: [
                {
                  index: 0,
                  kinds: state === "presentation" ? ["presentation"] : ["text"],
                  text: payload.text,
                  mediaUrls: state === "media" ? ["https://example.invalid/visible.png"] : [],
                },
                ...(state === "multiple-payloads"
                  ? [
                      {
                        index: 1,
                        kinds: ["text" as const],
                        text: "Unconfirmed second payload",
                        mediaUrls: [],
                      },
                    ]
                  : []),
              ],
            },
          },
          stateDir,
        );
        const cfg = { session: { store: scope.storePath } };
        const sessionKey = "agent:main:telegram:group:-100123";
        if (state === "stale-generation") {
          await replaceSessionEntry(
            { ...scope, sessionKey },
            {
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-revision",
              updatedAt: 100,
            },
          );
        }
        if (state !== "reconciled" && state !== "unresolved" && state !== "rejected") {
          await markConversationDeliverySent(scope, id, "visible-platform-message");
        } else if (state === "rejected") {
          await markConversationDeliveryRejected(scope, id, "rejected");
        } else {
          await markDeliveryPlatformSendAttemptStarted(id, stateDir);
          await markDeliveryPlatformOutcomeUnknown(id, stateDir);
          installUnknownSendResult(
            state === "reconciled"
              ? reconciledSent("visible-platform-message")
              : { status: "unresolved", error: "provider has no receipt" },
          );
        }
        if (previouslyCommitted) {
          expect(
            await confirmedVisibleMessage.commitConfirmedVisibleMessage({
              config: cfg,
              channel: "telegram",
              to: "group:-100123",
              producer: { agentId: "main", key: "agent:main:background-job" },
              payload,
              deliveryId: id,
              payloadIndex: 2,
            }),
          ).toMatchObject({ ok: true });
        }
        await closeStateDatabaseForTest();
        await closeConversationAgentDatabases();
        const deliver = vi.fn();
        const log = createRecoveryLog();
        const recover = () =>
          recoverPendingDeliveries({
            cfg,
            stateDir,
            deliver,
            log,
          });
        const result = await recover();
        const confirmed = state !== "unresolved" && state !== "rejected";
        const projected =
          state === "sent" || state === "reconciled" || state === "other-generation";
        expect(result).toMatchObject(confirmed ? { recovered: 1 } : { failed: 1 });
        if (confirmed && !projected && state !== "stale-generation") {
          expectMockMessageContaining(
            log.warn,
            "delivered during recovery; content could not be confirmed for the conversation",
          );
        }
        expect(deliver).not.toHaveBeenCalled();
        const entry = loadSessionEntryReadOnly({ sessionKey, storePath: scope.storePath });
        const messages = entry
          ? (
              await loadTranscriptEvents({
                sessionKey,
                sessionId: entry.sessionId,
                storePath: scope.storePath,
              })
            )
              .map(readTranscriptEventMessage)
              .filter(Boolean)
          : [];
        expect(messages).toEqual(
          projected
            ? [
                expect.objectContaining({
                  role: "assistant",
                  provider: "openclaw",
                  model: "automation-result",
                  content: [{ type: "text", text: payload.text }],
                }),
              ]
            : [],
        );
        await closeStateDatabaseForTest();
        expect(await recover()).toEqual(RECOVERY_SUMMARY.empty);
        expect(deliver).not.toHaveBeenCalled();
      });
    },
  );
  it.each(["sent", "reconciled"] as const)(
    "warns without retrying a %s delivery when transcript commit fails",
    async (state) => {
      const id = `failed-transcript-${state}`;
      const scope = await createConversationRecoveryFixture(id, {
        preparedBatch: {
          schemaVersion: 1,
          sourcePayloadCount: 1,
          channelNormalized: true,
          entries: [
            {
              status: "accepted",
              sourceIndex: 0,
              payload: { text: "hello" },
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
          items: [{ index: 0, kinds: ["text"], text: "hello", mediaUrls: [] }],
        },
      });
      if (state === "sent") {
        await markConversationDeliverySent(scope, id, "sent-platform-message");
      } else {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
        installUnknownSendResult(reconciledSent("sent-platform-message"));
      }
      const commit = vi
        .spyOn(confirmedVisibleMessage, "commitConfirmedVisibleMessage")
        .mockRejectedValueOnce(new Error("transcript storage unavailable"));
      const deliver = vi.fn();
      try {
        const { result, log } = await runRecovery({ deliver });
        expect(result).toEqual(RECOVERY_SUMMARY.recovered);
        expect(commit).toHaveBeenCalledOnce();
        expectMockMessageContaining(log.warn, "transcript storage unavailable");
        expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
        expect((await runRecovery({ deliver })).result).toEqual(RECOVERY_SUMMARY.empty);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        commit.mockRestore();
      }
    },
  );
});
