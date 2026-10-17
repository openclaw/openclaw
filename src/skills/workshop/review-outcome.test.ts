import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { assertSkillReviewRunSucceeded, postWorkshopChangeNotice } from "./review-outcome.js";

const mocks = vi.hoisted(() => ({
  extractDeliveryInfo: vi.fn(),
  withSessionEntriesFromStoresInWorker: vi.fn(),
  readEntry: vi.fn(),
  sendDurableMessageBatchCore: vi.fn(async () => ({ status: "sent" })),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true })),
  enqueueSystemEvent: vi.fn(() => true),
}));
vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  withSessionEntriesFromStoresInWorker: mocks.withSessionEntriesFromStoresInWorker,
}));
vi.mock("../../channels/message/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/message/runtime.js")>()),
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatchCore,
}));
vi.mock("../../config/sessions/transcript.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.runtime.js")>()),
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

describe("assertSkillReviewRunSucceeded", () => {
  it("does not fail a review whose tool calls were denied or errored", () => {
    const warning = setReplyPayloadMetadata(
      { isError: true, text: "⚠️ skill_workshop failed: View it first." },
      { toolErrorWarning: { toolName: "skill_workshop" } },
    );
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          toolSummary: {
            calls: 3,
            tools: ["sessions_yield", "skill_workshop"],
            failures: 1,
            unresolvedError: { toolName: "skill_workshop" },
          },
        },
        payloads: [warning],
      }),
    ).not.toThrow();
  });

  it("fails on model or runtime errors", () => {
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: { durationMs: 1, error: { kind: "retry_limit", message: "model retries exhausted" } },
      }),
    ).toThrow("model retries exhausted");
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: { durationMs: 1 },
        payloads: [{ isError: true, text: "LLM request failed: 529 overloaded" }],
      }),
    ).toThrow("529 overloaded");
    expect(() => assertSkillReviewRunSucceeded({ meta: { durationMs: 1, aborted: true } })).toThrow(
      "aborted",
    );
  });
});

describe("postWorkshopChangeNotice", () => {
  const dirs = useSessionStoreTempDirs(afterAll, "workshop-notice-");
  const change = (overrides: Partial<WorkshopChange>): WorkshopChange => ({
    id: "c1",
    agentId: "main",
    skillName: "actual-budget-operations",
    action: "patch",
    actor: "review",
    summary: "tightened reconciliation step",
    createdAtMs: 1,
    ...overrides,
  });
  const generation = (sessionKey: string) => ({
    agentId: "main",
    storePath: "/tmp/sessions.json",
    sessionKey,
    sessionId: "reviewed-session",
    lifecycleRevision: "reviewed-revision",
  });
  const reviewId = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
  const runId = `skill-workshop-review:${reviewId}`;
  const post = (
    changes: WorkshopChange[],
    sessionKey = "agent:main:telegram:direct:42",
    config: OpenClawConfig = {},
  ) =>
    postWorkshopChangeNotice({
      config,
      generation: generation(sessionKey),
      runId,
      changes,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readEntry.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reviewed-revision",
    });
    mocks.withSessionEntriesFromStoresInWorker.mockImplementation(async (inputs, consume) =>
      consume(
        inputs.map(({ sessionKeys }: { sessionKeys: readonly string[] }) => ({
          result: {
            entries: sessionKeys.map((sessionKey) => ({ sessionKey, entry: mocks.readEntry() })),
          },
        })),
      ),
    );
  });

  it("stays quiet when the review changed nothing", async () => {
    await post([]);
    expect(mocks.extractDeliveryInfo).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("sends one line with an Undo command button into the session thread when channel notices are enabled", async () => {
    const sessionKey = "agent:main:discord:channel:123:thread:456";
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
        threadId: "stale-thread",
      },
      threadId: "456",
    });
    await post(
      [
        change({ id: "c2", versionId: "20260101T000000002Z-patch", createdAtMs: 2 }),
        change({
          id: "c1",
          summary: "first pass",
          versionId: "20260101T000000001Z-patch",
          createdAtMs: 1,
        }),
        change({
          id: "c3",
          skillName: "release-notes",
          action: "create",
          summary: "drafting release notes",
          createdAtMs: 3,
        }),
        change({
          id: "c4",
          skillName: "release-notes",
          summary: "fixed a typo",
          createdAtMs: 4,
        }),
      ],
      sessionKey,
      { skills: { workshop: { autonomous: { channelNotices: true } } } },
    );
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(1);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:123",
        threadId: "456",
        payloads: [
          {
            text: '💾 Learned: updated `actual-budget-operations` (tightened reconciliation step); created `release-notes` (drafting release notes). Say "undo" to revert this skill change.',
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Undo",
                      action: { type: "command", command: `/learn undo ${reviewId}` },
                    },
                  ],
                },
              ],
            },
          },
        ],
        mirror: expect.objectContaining({ sessionKey }),
      }),
      undefined,
      undefined,
      generation(sessionKey),
    );
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    // The next turn learns the exact revert: archive what was created; restore what was edited
    // to the version saved before the review's first change of it.
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        "skill_workshop action=restore name=actual-budget-operations version=20260101T000000001Z-patch;",
      ),
      expect.anything(),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('skill_workshop action=archive name=release-notes reason="undo"'),
      expect.anything(),
    );
  });

  it("marks a default transcript notice with each skill's net change without a delivery target", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
    await post([
      change({ id: "c2", versionId: "20260101T000000002Z-patch", createdAtMs: 2 }),
      change({ id: "c1", versionId: "20260101T000000001Z-patch", createdAtMs: 1 }),
      change({
        id: "c3",
        skillName: "release-notes",
        action: "create",
        summary: "drafting release notes",
        createdAtMs: 3,
      }),
      change({ id: "c4", skillName: "release-notes", versionId: "v-typo", createdAtMs: 4 }),
    ]);
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    // The Control UI renders this marker natively: a later edit of a created skill stays "created".
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:42",
        text: expect.stringContaining("💾 Learned: updated `actual-budget-operations`"),
        deliveryMirror: {
          kind: "skill-workshop-change",
          agentId: "main",
          runId,
          skills: [
            {
              name: "actual-budget-operations",
              action: "updated",
              summary: "tightened reconciliation step",
            },
            { name: "release-notes", action: "created", summary: "drafting release notes" },
          ],
        },
      }),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('skill_workshop action=archive name=release-notes reason="undo"'),
      { sessionKey: "agent:main:telegram:direct:42" },
    );
  });

  it("records a Slack transcript notice even when channel notices are enabled", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "slack", to: "slack:c0123abc", accountId: "workspace-1" },
      threadId: "1234567890.123456",
    });
    const sessionKey = "agent:main:slack:channel:c0123abc:thread:1234567890.123456";
    await post([change({})], sessionKey, {
      skills: { workshop: { autonomous: { channelNotices: true } } },
    });
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        expectedSessionId: "reviewed-session",
        expectedLifecycleRevision: "reviewed-revision",
        deliveryMirror: {
          kind: "skill-workshop-change",
          agentId: "main",
          runId,
          skills: [
            {
              name: "actual-budget-operations",
              action: "updated",
              summary: "tightened reconciliation step",
            },
          ],
        },
      }),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(expect.any(String), { sessionKey });
  });

  it.each([
    {
      change: "reset",
      entry: { sessionId: "reviewed-session", lifecycleRevision: "reset-revision" },
    },
    {
      change: "replacement",
      entry: { sessionId: "replacement-session", lifecycleRevision: "reviewed-revision" },
    },
    { change: "deletion", entry: undefined },
  ])("leaves a conversation untouched after $change", async ({ entry }) => {
    mocks.readEntry.mockReturnValue(entry);
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "42" },
      threadId: undefined,
    });
    await post([change({})]);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("observes a reset during delivery lookup before enqueueing undo instructions", async () => {
    mocks.extractDeliveryInfo.mockImplementationOnce(async () => {
      mocks.readEntry.mockReturnValueOnce({
        sessionId: "reviewed-session",
        lifecycleRevision: "reset-revision",
      });
      return { deliveryContext: { channel: "telegram", to: "42" } };
    });
    await post([change({})]);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("keeps undo instructions after delivery failure without rereading the generation", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "42" },
    });
    mocks.sendDurableMessageBatchCore.mockRejectedValueOnce(new Error("delivery failed"));
    await post([change({})], undefined, {
      skills: { workshop: { autonomous: { channelNotices: true } } },
    });
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(mocks.withSessionEntriesFromStoresInWorker).toHaveBeenCalledOnce();
  });

  it("reads notice eligibility off-thread and observes a committed reset", async () => {
    const currentGeneration = {
      ...generation("agent:main:workshop-worker"),
      storePath: path.join(dirs.make(), "sessions.sqlite"),
    };
    const entry = {
      sessionId: currentGeneration.sessionId,
      lifecycleRevision: currentGeneration.lifecycleRevision,
      updatedAt: 1,
    };
    // Fixture commits must not schedule unrelated maintenance inside the SQL observation window.
    replaceSessionEntrySync(currentGeneration, entry);
    const { withSessionEntriesFromStoresInWorker } = await vi.importActual<
      typeof import("../../config/sessions/session-entry-read-runtime.js")
    >("../../config/sessions/session-entry-read-runtime.js");
    mocks.withSessionEntriesFromStoresInWorker.mockImplementation(
      withSessionEntriesFromStoresInWorker,
    );
    mocks.extractDeliveryInfo.mockResolvedValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    const { db } = openOpenClawAgentDatabase({
      agentId: currentGeneration.agentId,
      path: currentGeneration.storePath,
    });
    const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
    const reads: string[] = [];
    const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(read, receiver: StatementSync, args) {
            if (/\b(?:session_nodes|session_windows)\b/iu.test(receiver.sourceSQL)) {
              reads.push(receiver.sourceSQL);
            }
            return Reflect.apply(read, receiver, args);
          },
        }),
      );
    });
    const publish = () =>
      postWorkshopChangeNotice({
        config: {},
        generation: currentGeneration,
        runId,
        changes: [change({})],
      });
    try {
      await publish();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
      expect(reads).toEqual([]);
      replaceSessionEntrySync(currentGeneration, {
        ...entry,
        lifecycleRevision: "committed-reset",
        updatedAt: 2,
      });
      reads.length = 0;
      mocks.appendAssistantMessageToSessionTranscript.mockClear();
      mocks.enqueueSystemEvent.mockClear();
      await publish();
      expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(reads).toEqual([]);
    } finally {
      for (const observer of observers) {
        observer.mockRestore();
      }
    }
  });
});
