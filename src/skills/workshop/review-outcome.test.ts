import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { assertSkillReviewRunSucceeded, postWorkshopChangeNotice } from "./review-outcome.js";

const mocks = vi.hoisted(() => ({
  delivery: vi.fn(),
  readEntries: vi.fn(),
  entry: vi.fn(),
  send: vi.fn(async () => ({ status: "sent" })),
  append: vi.fn(async () => ({ ok: true })),
  enqueue: vi.fn(() => true),
}));
vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: mocks.delivery,
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  withSessionEntriesFromStoresInWorker: mocks.readEntries,
}));
vi.mock("../../channels/message/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/message/runtime.js")>()),
  sendDurableMessageBatchCore: mocks.send,
}));
vi.mock("../../config/sessions/transcript.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.runtime.js")>()),
  appendAssistantMessageToSessionTranscript: mocks.append,
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueue,
}));

describe("assertSkillReviewRunSucceeded", () => {
  type Result = Parameters<typeof assertSkillReviewRunSucceeded>[0];
  const review = (meta: Omit<Result["meta"], "durationMs">, payloads?: Result["payloads"]) =>
    expect(() => assertSkillReviewRunSucceeded({ meta: { durationMs: 1, ...meta }, payloads }));
  it("does not fail a review whose tool calls were denied or errored", () => {
    const warning = setReplyPayloadMetadata(
      { isError: true, text: "⚠️ skill_workshop failed: View it first." },
      { toolErrorWarning: { toolName: "skill_workshop" } },
    );
    review(
      {
        toolSummary: {
          calls: 3,
          tools: ["sessions_yield", "skill_workshop"],
          failures: 1,
          unresolvedError: { toolName: "skill_workshop" },
        },
      },
      [warning],
    ).not.toThrow();
  });

  it("fails on model or runtime errors", () => {
    review({ error: { kind: "retry_limit", message: "model retries exhausted" } }).toThrow(
      "model retries exhausted",
    );
    review({}, [{ isError: true, text: "LLM request failed: 529 overloaded" }]).toThrow(
      "529 overloaded",
    );
    review({ aborted: true }).toThrow("aborted");
  });
});

describe("postWorkshopChangeNotice", () => {
  const dirs = useSessionStoreTempDirs(afterAll, "workshop-notice-");
  const change = (overrides: Partial<WorkshopChange>): WorkshopChange => ({
    id: "c1",
    agentId: "main",
    skillName: "budget",
    action: "patch",
    actor: "review",
    summary: "reconciled",
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
  const channelNotices: OpenClawConfig = {
    skills: { workshop: { autonomous: { channelNotices: true } } },
  };
  const reviewChanges = (
    summary = "first pass",
    lastEdit: Partial<WorkshopChange> = { summary: "typo" },
  ) => [
    change({ versionId: "v2", createdAtMs: 2 }),
    change({ summary, versionId: "v1", createdAtMs: 1 }),
    change({ skillName: "notes", action: "create", summary: "drafting", createdAtMs: 3 }),
    change({ skillName: "notes", createdAtMs: 4, ...lastEdit }),
  ];
  const marker = (includeRelease = false) => ({
    kind: "skill-workshop-change",
    agentId: "main",
    runId,
    skills: [
      { name: "budget", action: "updated", summary: "reconciled" },
      ...(includeRelease ? [{ name: "notes", action: "created", summary: "drafting" }] : []),
    ],
  });
  const expectNoNotice = () => {
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  };
  const post = (
    changes: WorkshopChange[],
    sessionKey = "agent:main:telegram:direct:42",
    config: OpenClawConfig = {},
  ) => postWorkshopChangeNotice({ config, generation: generation(sessionKey), runId, changes });
  const delivery = (channel = "telegram", to = "42", threadId?: string, accountId?: string) =>
    mocks.delivery.mockReturnValue({
      deliveryContext: { channel, to, accountId },
      threadId,
    });
  const expectTranscript = (fields: Record<string, unknown>) =>
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining(fields));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entry.mockReturnValue({
      sessionId: "reviewed-session",
      lifecycleRevision: "reviewed-revision",
    });
    mocks.readEntries.mockImplementation(async (inputs, consume) =>
      consume(
        inputs.map(({ sessionKeys }: { sessionKeys: readonly string[] }) => ({
          result: {
            entries: sessionKeys.map((sessionKey) => ({ sessionKey, entry: mocks.entry() })),
          },
        })),
      ),
    );
  });

  it("stays quiet when the review changed nothing", async () => {
    await post([]);
    expect(mocks.delivery).not.toHaveBeenCalled();
    expectNoNotice();
  });

  it("sends one line with an Undo command button into the session thread when channel notices are enabled", async () => {
    const sessionKey = "agent:main:discord:channel:123:thread:456";
    mocks.delivery.mockReturnValue({
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
        threadId: "stale-thread",
      },
      threadId: "456",
    });
    await post(reviewChanges(), sessionKey, channelNotices);
    const button = {
      label: "Undo",
      action: { type: "command", command: `/learn undo ${reviewId}` },
    };
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:123",
        threadId: "456",
        payloads: [
          {
            text: '💾 Learned: updated `budget` (reconciled); created `notes` (drafting). Say "undo" to revert this skill change.',
            presentation: { blocks: [{ type: "buttons", buttons: [button] }] },
          },
        ],
        mirror: expect.objectContaining({ sessionKey }),
      }),
      undefined,
      undefined,
      generation(sessionKey),
    );
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("skill_workshop action=restore name=budget version=v1;"),
      expect.anything(),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.stringContaining('skill_workshop action=archive name=notes reason="undo"'),
      expect.anything(),
    );
  });

  it.each([false, true])("records a transcript notice (Slack=%s)", async (slack) => {
    if (slack) {
      delivery("slack", "slack:c0123abc", "1234567890.123456", "workspace-1");
    } else {
      mocks.delivery.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
    }
    const sessionKey = slack
      ? "agent:main:slack:channel:c0123abc:thread:1234567890.123456"
      : "agent:main:telegram:direct:42";
    await post(
      slack ? [change({})] : reviewChanges("reconciled", { versionId: "v-typo" }),
      sessionKey,
      slack ? channelNotices : {},
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expectTranscript({
      sessionKey,
      ...(slack
        ? { expectedSessionId: "reviewed-session", expectedLifecycleRevision: "reviewed-revision" }
        : { text: expect.stringContaining("💾 Learned: updated `budget`") }),
      deliveryMirror: marker(!slack),
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      slack
        ? expect.any(String)
        : expect.stringContaining('skill_workshop action=archive name=notes reason="undo"'),
      { sessionKey },
    );
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
    mocks.entry.mockReturnValue(entry);
    delivery();
    await post([change({})]);
    expectNoNotice();
  });

  it("observes a reset during delivery lookup before enqueueing undo instructions", async () => {
    mocks.delivery.mockImplementationOnce(async () => {
      mocks.entry.mockReturnValueOnce({
        sessionId: "reviewed-session",
        lifecycleRevision: "reset-revision",
      });
      return { deliveryContext: { channel: "telegram", to: "42" } };
    });
    await post([change({})]);
    expectNoNotice();
  });

  it("keeps undo instructions after delivery failure without rereading the generation", async () => {
    delivery();
    mocks.send.mockRejectedValueOnce(new Error("delivery failed"));
    await post([change({})], undefined, channelNotices);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.readEntries).toHaveBeenCalledOnce();
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
    const { withSessionEntriesFromStoresInWorker } = await vi.importActual<
      typeof import("../../config/sessions/session-entry-read-runtime.js")
    >("../../config/sessions/session-entry-read-runtime.js");
    // Fixture commits must not schedule maintenance inside the read observation window.
    replaceSessionEntrySync(currentGeneration, entry);
    mocks.readEntries.mockImplementation(withSessionEntriesFromStoresInWorker);
    mocks.delivery.mockResolvedValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    const sql = observeHostDataSql();
    const reads = () =>
      sql.queries.filter((query) => /\b(?:session_nodes|session_windows)\b/iu.test(query));
    const publish = () =>
      postWorkshopChangeNotice({
        config: {},
        generation: currentGeneration,
        runId,
        changes: [change({})],
      });
    try {
      await publish();
      expect(mocks.append).toHaveBeenCalledTimes(1);
      expect(reads()).toEqual([]);
      replaceSessionEntrySync(currentGeneration, {
        ...entry,
        lifecycleRevision: "committed-reset",
        updatedAt: 2,
      });
      sql.queries.length = 0;
      mocks.append.mockClear();
      mocks.enqueue.mockClear();
      await publish();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(reads()).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});
