import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionMutationHandlers } from "../gateway/server-methods/sessions-mutations.js";
import { callGatewayHandler } from "../gateway/server-methods/skills.test-helpers.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";
import { beginSessionEffect, getSessionMutationCount } from "./session-controller.lifecycle.js";
import { onSessionTranscriptUpdate } from "./transcript-events.js";

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
  const admit = (signal?: AbortSignal) =>
    beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      signal,
    });
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
  return {
    config,
    generation,
    scope,
    commit,
    replace,
    admit,
    sessionId,
    sessionKey,
    storePath,
  };
}

it("waits for active source work, commits provenance, and deduplicates retry", async () => {
  const target = await createTarget();
  const admission = await target.admit();
  const commitSettled = vi.fn(() => {});
  const controller = new AbortController();
  const updates: unknown[] = [];
  const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
  const commit = target.commit({ signal: controller.signal });
  const observations = [commit.then(commitSettled, commitSettled)];
  let laterAdmission: ReturnType<typeof beginSessionEffect> | undefined;

  try {
    await vi.waitFor(() => expect(getSessionMutationCount()).toBe(1));
    expect(commitSettled).not.toHaveBeenCalled();
    const laterAdmissionSettled = vi.fn(() => {});
    laterAdmission = target.admit(controller.signal);
    observations.push(laterAdmission.then(laterAdmissionSettled, laterAdmissionSettled));
    await Promise.resolve();
    expect(laterAdmissionSettled).not.toHaveBeenCalled();
    admission.release();

    const first = await commit;
    expect(first).toMatchObject({ ok: true });
    (await laterAdmission).release();
    const retry = await target.commit();
    expect(retry).toEqual(first);
    await expect(
      target.commit({
        text: "A different completion must not reuse the committed run.",
      }),
    ).rejects.toThrow("conflicts with the admitted message");

    const events = await loadTranscriptEvents(target.scope);
    expect(events).toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
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
      }),
    ]);
    expect(updates).toHaveLength(1);
  } finally {
    controller.abort();
    admission.release();
    unsubscribe();
    await laterAdmission?.then(
      (lease) => lease.release(),
      () => {},
    );
    await Promise.allSettled([commit, ...observations]);
  }
});

it("cancels a background completion's pure wait without waiting for old work release", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const target = await createTarget();
    const admission = await target.admit();
    const controller = new AbortController();
    const prepareDisplayContent = vi.fn(async () => undefined);
    const pending: Promise<unknown>[] = [];
    let completionOutcome:
      | PromiseSettledResult<Awaited<ReturnType<typeof commitBackgroundResultToSession>>>
      | undefined;
    let sourceResponse: Awaited<ReturnType<typeof callGatewayHandler>> | undefined;
    try {
      const completion = target.commit({
        text: "Cancelled synthetic background result",
        prepareDisplayContent,
        idempotencyKey: "background-cancellation-progress",
        provenance: {
          kind: "cron",
          jobId: "synthetic-cancel-job",
          runId: "synthetic-cancel-run",
        },
        signal: controller.signal,
      });
      pending.push(completion);
      const completionSettlement = Promise.allSettled([completion]).then(([result]) => {
        completionOutcome = result;
      });
      pending.push(completionSettlement);
      await vi.waitFor(() => expect(getSessionMutationCount()).toBe(1));
      expect(prepareDisplayContent).not.toHaveBeenCalled();
      const sourceMutation = admission.run(async () => {
        sourceResponse = await callGatewayHandler(
          sessionMutationHandlers,
          "sessions.patch",
          { key: target.sessionKey, pinned: true },
          {
            context: {
              getRuntimeConfig: () => target.config,
              getSessionEventSubscriberConnIds: () => new Set<string>(),
              broadcastToConnIds: vi.fn(),
              dedupe: new Map(),
            },
          },
        );
        return sourceResponse;
      });
      pending.push(sourceMutation);
      controller.abort();
      await completionSettlement;
      expect(
        completionOutcome,
        "cancelled background completion must settle while the unrelated old lease stays held",
      ).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
      await expect(sourceMutation).resolves.toMatchObject({ ok: true });
      expect(admission.isActive()).toBe(true);
      expect(getSessionMutationCount()).toBe(0);
      expect(prepareDisplayContent).not.toHaveBeenCalled();
      const scope = target.scope;
      expect(loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" })).toMatchObject({
        pinnedAt: expect.any(Number),
        sessionId: target.sessionId,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
    } finally {
      controller.abort();
      admission.release();
      const settled = await Promise.allSettled(pending);
      expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(completionOutcome).toMatchObject({
        status: "rejected",
        reason: { name: "AbortError" },
      });
      expect(sourceResponse).toMatchObject({ ok: true });
      expect(getSessionMutationCount()).toBe(0);
      expect(await loadTranscriptEvents(target.scope)).toEqual([]);
    }
  });
});

it.each([false, true])(
  "settles accepted display content with provider review paused=%s",
  async (paused) => {
    const target = await createTarget();
    if (paused) {
      const scope = target.scope;
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      writeSessionEntry(
        database,
        target.sessionKey,
        {
          sessionId: target.sessionId,
          lifecycleRevision: target.generation.lifecycleRevision,
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
      idempotencyKey: "cron-current-completion:cron:job-media:4000",
      provenance: { kind: "cron", jobId: "job-media", runId: "cron:job-media:4000" },
    });
    expect(commit).toMatchObject({ ok: true });

    const events = await loadTranscriptEvents(target.scope);
    const messageEvent = events.find(
      (event) =>
        readTranscriptEventMessage(event)?.idempotencyKey ===
        "cron-current-completion:cron:job-media:4000",
    );
    const message = readTranscriptEventMessage(messageEvent);
    expect({ content: message?.content, display: message?.openclawDisplayContent }).toEqual({
      content: [{ type: "text", text: "Example report\nreport.png" }],
      display: content,
    });
  },
);

it("refuses an archived target conversation", async () => {
  const target = await createTarget();
  await target.replace({ archivedAt: 2 });

  await expect(target.commit()).resolves.toMatchObject({
    ok: false,
    reason: expect.stringContaining("archived"),
  });
});

it("does not commit when cancelled during display preparation", async () => {
  const target = await createTarget();
  const controller = new AbortController();
  await expect(
    target.commit({
      text: "Cancelled report",
      prepareDisplayContent: async () => {
        controller.abort();
        return [{ type: "text", text: "Cancelled report" }];
      },
      idempotencyKey: "cancelled-completion",
      provenance: { kind: "cron", jobId: "cancelled-job", runId: "cancelled-run" },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await loadTranscriptEvents(target.scope)).toEqual([]);
});

it.each([
  {
    name: "session-id replacement",
    sessionId: "replacement-session",
    lifecycleRevision: "replacement-revision",
  },
  {
    name: "same-id lifecycle replacement",
    sessionId: "source-session",
    lifecycleRevision: "replacement-revision",
  },
])("refuses a result captured before $name", async ({ name: _name, ...replacement }) => {
  const target = await createTarget();
  await target.replace(replacement);

  await expect(target.commit()).resolves.toMatchObject({
    ok: false,
    reason: expect.stringContaining("session rebound"),
  });

  await expect(
    loadTranscriptEvents({ ...target.scope, sessionId: replacement.sessionId }),
  ).resolves.toEqual([]);
});

it("treats a missing lifecycle revision as exact generation state", async () => {
  const target = await createTarget();
  const generation = { sessionId: target.sessionId, lifecycleRevision: undefined };
  await target.replace({ lifecycleRevision: undefined });

  await expect(
    target.commit({
      expectedGeneration: generation,
      text: "This still belongs to the revision-less session.",
      idempotencyKey: "cron-current-completion:cron:job-legacy:4000",
      provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:4000" },
    }),
  ).resolves.toMatchObject({ ok: true });

  await target.replace({ lifecycleRevision: "materialized-revision", updatedAt: 3 });
  await expect(
    target.commit({
      expectedGeneration: generation,
      text: "Do not append after the generation changes.",
      idempotencyKey: "cron-current-completion:cron:job-legacy:5000",
      provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:5000" },
    }),
  ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("session rebound") });
});
