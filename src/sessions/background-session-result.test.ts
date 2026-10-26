import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { transformMessages } from "../../packages/ai/src/transcript-transform.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sanitizeSessionHistory } from "../agents/embedded-agent-runner/replay-history.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  armGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import type { Message } from "../llm/types.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { getSessionMutationCount, runSessionMutation } from "./session-controller.lifecycle.js";
import { onSessionTranscriptUpdate } from "./transcript-events.js";

registerAgentSessionLoopTestLifecycle();

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const root of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(root);
      closeOpenClawAgentDatabasesForTest(root);
    }
    cleanup();
  }),
);

async function createTarget() {
  const dir = tempDirs.make("openclaw-background-result-");
  const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = "agent:main:webchat:direct:owner";
  const sessionId = "source-session";
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    { sessionId, lifecycleRevision: "source-revision", updatedAt: 1 },
  );
  const scope = { agentId: "main", sessionKey, sessionId, storePath };
  const config = { session: { store: storePath } };
  const generation = { sessionId, lifecycleRevision: "source-revision" };
  const replace = (overrides: Partial<SessionEntry>) =>
    replaceSessionEntry(scope, { ...generation, updatedAt: 2, ...overrides });
  const commit = (overrides: Partial<Parameters<typeof commitBackgroundResultToSession>[0]> = {}) =>
    commitBackgroundResultToSession({
      agentId: "main",
      sessionKey,
      expectedGeneration: generation,
      text: "Automation finished while the chat was active.",
      idempotencyKey: "cron-current-completion:cron:job-1:1000",
      provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
      config,
      ...overrides,
    });
  return { config, generation, scope, commit, replace, ...scope };
}

const lookupCall = { role: "assistant", content: [{ type: "toolCall", id: "lookup-call" }] };
const lookupResult = { role: "toolResult", toolCallId: "lookup-call", isError: false };
const automationResult = { role: "assistant", model: "automation-result" };

it("deduplicates background output without breaking live or replayed tool results", async ({
  signal,
}) => {
  const target = await createTarget();
  const manager = await SessionManager.openAsync(target.scope);
  const entered = createDeferred();
  const finishTool = createDeferred();
  const requests: Message[][] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      requests.length === 1
        ? createAssistant(
            model,
            [{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }],
            "toolUse",
          )
        : createAssistant(model, "Lookup completed"),
    );
  });
  const { session } = await createTestSession({
    sessionManager: manager,
    customTools: [
      {
        name: "lookup",
        label: "Lookup",
        description: "Synthetic lookup",
        parameters: Type.Object({}),
        execute: async () => {
          entered.resolve();
          await finishTool.promise;
          return { content: [{ type: "text", text: "Actual lookup result" }], details: {} };
        },
      },
    ],
  });
  const updates: unknown[] = [];
  const turn = withSessionTurn(target, () => session.prompt("Run lookup"));
  try {
    await withinTest(entered.promise, signal);
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const [first, retry] = await withinTest(
        Promise.all([target.commit(), target.commit()]),
        signal,
      );
      expect(first).toEqual({ ok: true });
      expect(retry).toEqual(first);
      await expect(target.commit({ text: "Conflicting completion" })).rejects.toThrow(
        "conflicts with the admitted message",
      );
      expect(updates).toHaveLength(1);
    } finally {
      unsubscribe();
    }
    expect(getSessionMutationCount()).toBe(0);
    finishTool.resolve();
    await withinTest(turn, signal);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject([{ role: "user" }, lookupCall, lookupResult]);
    const reopened = await SessionManager.openAsync(target.scope);
    const stored = reopened.buildSessionContext().messages;
    expect(stored).toMatchObject([
      { role: "user" },
      lookupCall,
      automationResult,
      lookupResult,
      { role: "assistant" },
    ]);
    expect(stored[2]).toEqual(
      expect.objectContaining({
        api: "openclaw-transcript",
        idempotencyKey: "cron-current-completion:cron:job-1:1000",
        model: "automation-result",
        openclawAutomation: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
        provider: "openclaw",
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Automation finished while the chat was active." }],
        usage: expect.objectContaining({ input: 0, output: 0, totalTokens: 0 }),
      }),
    );
    const events = await loadTranscriptEvents(target.scope);
    expect(events.at(-1)).toMatchObject({
      parentId: readTranscriptEventId(events.at(-2)),
      message: { role: "assistant", content: [{ type: "text", text: "Lookup completed" }] },
    });
    const replay = await sanitizeSessionHistory({
      messages: stored,
      sessionManager: reopened,
      sessionId: target.sessionId,
      provider: testModel.provider,
      modelId: testModel.id,
      modelApi: testModel.api,
      config: { plugins: { enabled: false } },
    });
    const providerMessages = replay.filter(
      (message): message is Message =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    );
    const transformed = transformMessages(providerMessages, testModel);
    expect(transformed).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ type: "toolCall", id: expect.any(String) }] },
      {
        role: "toolResult",
        toolCallId: expect.any(String),
        content: [{ type: "text", text: "Actual lookup result" }],
        isError: false,
      },
      automationResult,
      { role: "assistant" },
    ]);
    const call = transformed[1];
    const result = transformed[2];
    if (call?.role !== "assistant" || result?.role !== "toolResult") {
      throw new Error("Expected paired tool call and result");
    }
    expect(call.content).toMatchObject([{ type: "toolCall", id: result.toolCallId }]);
    expect(manager.buildSessionContext().messages).toEqual(stored);
  } finally {
    finishTool.resolve();
    await turn;
  }
});

it("cancels a background result queued behind a mutation without retaining custody", async () => {
  const target = await createTarget();
  const entered = createDeferred();
  const finish = createDeferred();
  const prior = runSessionMutation({
    scope: target.storePath,
    identities: [target.sessionKey, target.sessionId],
    run: async () => {
      entered.resolve();
      await finish.promise;
    },
  });
  await entered.promise;
  const controller = new AbortController();
  const prepareDisplayContent = vi.fn(async () => undefined);
  const completion = target.commit({ signal: controller.signal, prepareDisplayContent });
  try {
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(prepareDisplayContent).not.toHaveBeenCalled();
    finish.resolve();
    await prior;
    expect(getSessionMutationCount()).toBe(0);
    expect(await loadTranscriptEvents(target.scope)).toEqual([]);
  } finally {
    finish.resolve();
    await Promise.allSettled([completion, prior]);
  }
});

it("releases background-result write custody during suspension while the turn runs", async ({
  signal,
}) => {
  const target = await createTarget();
  const started = createDeferred();
  const finishTurn = createDeferred();
  const committed = createDeferred();
  const finishCommit = createDeferred();
  const turn = withSessionTurn(target, async () => {
    started.resolve();
    await finishTurn.promise;
  });
  await started.promise;
  const completion = target.commit({
    onMessageCommitted: (_message, acceptCompletion) => {
      acceptCompletion(async () => {
        committed.resolve();
        await finishCommit.promise;
      });
    },
  });
  let suspensionId: string | undefined;
  try {
    await withinTest(committed.promise, signal);
    const suspension = prepareGatewaySuspend({
      requestId: "background-result-drain",
      drain: true,
      terminalPolicy: "terminate",
      inspect: { getTerminalPersistence: () => 0 },
      pauseScheduling: () => {},
      resumeScheduling: () => {},
    });
    expect(suspension.status).toBe("draining");
    if (suspension.status !== "draining") {
      throw new Error("Expected a draining suspension");
    }
    suspensionId = suspension.suspensionId;
    expect(getGatewaySuspendStatus(suspensionId)).toMatchObject({
      status: "draining",
      writeCustody: [{ phase: "session-mutation", count: 1 }],
    });
    finishCommit.resolve();
    await withinTest(completion, signal);
    expect(getGatewaySuspendStatus(suspensionId)).toMatchObject({
      status: "draining",
      writeCustody: [],
    });
    expect(getSessionMutationCount()).toBe(0);
    expect(await loadTranscriptEvents(target.scope)).toHaveLength(2);
    const commitStop = vi.fn(() => markGatewayRestartDraining());
    expect(
      armGatewaySuspendHandoff({
        suspensionId,
        owner: { isCurrent: () => true, commitStop },
        commit: true,
      }),
    ).toMatchObject({ ok: true, value: { status: "committed" } });
    expect(commitStop).toHaveBeenCalledOnce();
  } finally {
    finishCommit.resolve();
    finishTurn.resolve();
    await Promise.allSettled([completion, turn]);
    if (suspensionId) {
      resumeGatewaySuspend(suspensionId);
    }
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
  }
});

it.each([false, true])(
  "settles accepted display content with provider review paused=%s",
  async (paused) => {
    const target = await createTarget();
    if (paused) {
      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteScope(target.scope)),
      );
      writeSessionEntry(
        database,
        target.sessionKey,
        {
          ...target.generation,
          updatedAt: 1,
          providerReview: {
            id: "review",
            sessionId: target.sessionId,
            runId: "refused-run",
            provider: "openai",
            model: "gpt-5.6-sol",
            runtimeId: "openclaw",
            api: "openai-responses",
          },
        },
        { providerReviewMutation: true },
      );
    }
    const content = [
      { type: "text", text: "Example report" },
      {
        type: "image",
        url: "/api/chat/media/outgoing/source-session/attachment-1/full",
        alt: "report.png",
      },
    ];
    const commit = await target.commit({
      text: "Example report\nreport.png",
      prepareDisplayContent: async () => content,
    });
    expect(commit).toMatchObject({ ok: true });

    const events = await loadTranscriptEvents(target.scope);
    const message = events
      .map(readTranscriptEventMessage)
      .find((entry) => entry?.idempotencyKey === "cron-current-completion:cron:job-1:1000");
    expect({ content: message?.content, display: message?.openclawDisplayContent }).toEqual({
      content: [{ type: "text", text: "Example report\nreport.png" }],
      display: content,
    });
  },
);

it("does not commit when cancelled during display preparation", async () => {
  const target = await createTarget();
  const controller = new AbortController();
  await expect(
    target.commit({
      prepareDisplayContent: async () => {
        controller.abort();
        return [{ type: "text", text: "Cancelled report" }];
      },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await loadTranscriptEvents(target.scope)).toEqual([]);
});

it.each<[string, Partial<SessionEntry>, string]>([
  ["archived conversation", { archivedAt: 2 }, "archived"],
  ["session-id replacement", { sessionId: "replacement-session" }, "session rebound"],
  [
    "same-id lifecycle replacement",
    { lifecycleRevision: "replacement-revision" },
    "session rebound",
  ],
])("refuses %s", async (_, replacement, reason) => {
  const target = await createTarget();
  await target.replace(replacement);

  await expect(target.commit()).resolves.toMatchObject({
    ok: false,
    reason: expect.stringContaining(reason),
  });

  await expect(
    loadTranscriptEvents({
      ...target.scope,
      sessionId: replacement.sessionId ?? target.sessionId,
    }),
  ).resolves.toEqual([]);
});

it("treats a missing lifecycle revision as exact generation state", async () => {
  const target = await createTarget();
  const generation = { sessionId: target.sessionId, lifecycleRevision: undefined };
  await target.replace({ lifecycleRevision: undefined });

  await expect(
    target.commit({
      expectedGeneration: generation,
      idempotencyKey: "cron-current-completion:cron:job-legacy:4000",
      provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:4000" },
    }),
  ).resolves.toMatchObject({ ok: true });

  await target.replace({ lifecycleRevision: "materialized-revision", updatedAt: 3 });
  await expect(
    target.commit({
      expectedGeneration: generation,
      idempotencyKey: "cron-current-completion:cron:job-legacy:5000",
      provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:5000" },
    }),
  ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("session rebound") });
});
