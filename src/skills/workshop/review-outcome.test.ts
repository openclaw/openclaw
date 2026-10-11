import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { assertSkillReviewRunSucceeded, postWorkshopChangeNotice } from "./review-outcome.js";

const mocks = vi.hoisted(() => ({
  extractDeliveryInfo: vi.fn(),
  loadSessionEntryReadOnly: vi.fn(),
  sendDurableMessageBatchCore: vi.fn(async () => ({ status: "sent" })),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true })),
  enqueueSystemEvent: vi.fn(() => true),
}));
vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
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
  const post = (changes: WorkshopChange[], sessionKey = "agent:main:telegram:direct:42") =>
    postWorkshopChangeNotice({
      config: {},
      generation: generation(sessionKey),
      runId,
      changes,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reviewed-revision",
    });
  });

  it("stays quiet when the review changed nothing", async () => {
    await post([]);
    expect(mocks.extractDeliveryInfo).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("sends one line with an Undo command button to the originating chat", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "42" },
      threadId: undefined,
    });
    await post([
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
    ]);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(1);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledWith(
      {
        cfg: {},
        channel: "telegram",
        to: "42",
        accountId: undefined,
        threadId: undefined,
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
        session: {
          policyKey: "agent:main:telegram:direct:42",
          conversationType: "direct",
          agentId: "main",
        },
        deliveryIntentId: `skill-workshop-notice:${runId}`,
        transcriptExpectedGeneration: {
          sessionId: "reviewed-session",
          lifecycleRevision: "reviewed-revision",
        },
        bestEffort: true,
      },
      undefined,
      undefined,
      generation("agent:main:telegram:direct:42"),
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

  it("retains undo context without claiming delivery when the external notice fails", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "42" },
      threadId: undefined,
    });
    mocks.sendDurableMessageBatchCore.mockRejectedValueOnce(new Error("send failed"));

    await post([change({})]);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        'skill_workshop action=archive name=actual-budget-operations reason="undo"',
      ),
      expect.anything(),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.not.stringContaining("told the user"),
      expect.anything(),
    );
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("marks a channel-less transcript notice with each skill's net change", async () => {
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
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:42",
        storePath: "/tmp/sessions.json",
        expectedSessionId: "reviewed-session",
        expectedLifecycleRevision: "reviewed-revision",
        idempotencyKey: `skill-workshop-notice:${runId}`,
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
  });

  it("delivers into the thread named by the session key", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "discord", to: "channel:123", accountId: "default" },
      threadId: "456",
    });
    const sessionKey = "agent:main:discord:channel:123:thread:456";
    await post([change({})], sessionKey);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "discord", to: "channel:123", threadId: "456" }),
      undefined,
      undefined,
      generation(sessionKey),
    );
  });

  it("posts nothing for a Slack conversation and leaves the agent unprompted", async () => {
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
      threadId: "1234567890.123456",
    });
    await post([change({})], "agent:main:slack:channel:C0123ABC:thread:1234567890.123456");
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("leaves a conversation reset since the review started untouched", async () => {
    // A Gateway reset keeps the sessionId and rotates the lifecycle revision.
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reset-revision",
    });
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "42" },
      threadId: undefined,
    });
    await post([change({})]);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });
});
