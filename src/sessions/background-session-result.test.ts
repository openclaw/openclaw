import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { commitBackgroundResultToSession } from "./background-session-result.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "./transcript-events.js";

describe("commitBackgroundResultToSession", () => {
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
    return {
      config: { session: { store: storePath } },
      generation: { sessionId, lifecycleRevision: "source-revision" },
      sessionId,
      sessionKey,
      storePath,
    };
  }

  it("commits during active source work, preserves provenance, and deduplicates retry", async () => {
    const target = await createTarget();
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
    });
    let commitSettled = false;
    const controller = new AbortController();
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const commit = commitBackgroundResultToSession({
      agentId: "main",
      sessionKey: target.sessionKey,
      expectedGeneration: target.generation,
      text: "Automation finished while the chat was active.",
      idempotencyKey: "cron-current-completion:cron:job-1:1000",
      provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
      config: target.config,
      signal: controller.signal,
    });
    const observations: Promise<void>[] = [
      commit.then(
        () => {
          commitSettled = true;
        },
        () => {
          commitSettled = true;
        },
      ),
    ];

    try {
      await vi.waitFor(() => expect(commitSettled).toBe(true));
      expect(admission.isActive()).toBe(true);
      const first = await commit;
      expect(first).toMatchObject({ ok: true });
      const retry = await commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Automation finished while the chat was active.",
        idempotencyKey: "cron-current-completion:cron:job-1:1000",
        provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
        config: target.config,
      });
      expect(retry).toEqual(first);
      expect(admission.isActive()).toBe(true);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
      await expect(
        commitBackgroundResultToSession({
          agentId: "main",
          sessionKey: target.sessionKey,
          expectedGeneration: target.generation,
          text: "A different completion must not reuse the committed run.",
          idempotencyKey: "cron-current-completion:cron:job-1:1000",
          provenance: { kind: "cron", jobId: "job-1", runId: "cron:job-1:1000" },
          config: target.config,
        }),
      ).rejects.toThrow("conflicts with the admitted message");

      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
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
      await Promise.allSettled([commit, ...observations]);
    }
  });

  it.each(["cancel", "replace"] as const)(
    "revalidates a background result queued behind an existing lifecycle mutation: %s",
    async (action) => {
      const target = await createTarget();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const blocker = runExclusiveSessionLifecycleMutation("background-result", {
        scope: target.storePath,
        identities: [target.sessionKey, target.sessionId],
        run: async () => {
          entered.resolve();
          await release.promise;
          if (action === "replace") {
            await replaceSessionEntry(
              { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
              { sessionId: target.sessionId, lifecycleRevision: "replacement", updatedAt: 2 },
            );
          }
        },
      });
      await entered.promise;
      const controller = new AbortController();
      const prepareDisplayContent = vi.fn(async () => undefined);
      const result = commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Queued completion",
        idempotencyKey: "queued-completion",
        provenance: { kind: "cron", jobId: "queued", runId: "queued" },
        config: target.config,
        signal: controller.signal,
        prepareDisplayContent,
      });
      const observed = result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        if (action === "cancel") {
          controller.abort();
          await expect(result).rejects.toMatchObject({ name: "AbortError" });
        }
        release.resolve();
        await blocker;
        if (action === "replace") {
          await expect(result).resolves.toMatchObject({
            ok: false,
            reason: expect.stringContaining("session rebound"),
          });
        }
        expect(prepareDisplayContent).not.toHaveBeenCalled();
        await expect(
          loadTranscriptEvents({
            agentId: "main",
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            storePath: target.storePath,
          }),
        ).resolves.toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, observed]);
      }
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "settles accepted display content with provider review paused=%s",
    async (paused) => {
      const target = await createTarget();
      if (paused) {
        const scope = {
          agentId: "main",
          storePath: target.storePath,
          sessionKey: target.sessionKey,
        };
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
      const commit = await commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Example report\nreport.png",
        prepareDisplayContent: async () => content,
        idempotencyKey: "cron-current-completion:cron:job-media:4000",
        provenance: { kind: "cron", jobId: "job-media", runId: "cron:job-media:4000" },
        config: target.config,
      });
      expect(commit).toMatchObject({ ok: true });

      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
      const messageEvent = events.find(
        (event) =>
          readTranscriptEventMessage(event)?.idempotencyKey ===
          "cron-current-completion:cron:job-media:4000",
      );
      const message = readTranscriptEventMessage(messageEvent);
      expect(message?.content).toEqual([{ type: "text", text: "Example report\nreport.png" }]);
      expect(message?.openclawDisplayContent).toEqual(content);
    },
  );

  it("refuses an archived target conversation", async () => {
    const target = await createTarget();
    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      {
        sessionId: target.sessionId,
        lifecycleRevision: "source-revision",
        updatedAt: 2,
        archivedAt: 2,
      },
    );

    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Do not append this.",
        idempotencyKey: "cron-current-completion:cron:job-2:2000",
        provenance: { kind: "cron", jobId: "job-2", runId: "cron:job-2:2000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("archived") });
  });

  it("does not commit when cancelled during display preparation", async () => {
    const target = await createTarget();
    const controller = new AbortController();
    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Cancelled report",
        prepareDisplayContent: async () => {
          controller.abort();
          return [{ type: "text", text: "Cancelled report" }];
        },
        idempotencyKey: "cancelled-completion",
        provenance: { kind: "cron", jobId: "cancelled-job", runId: "cancelled-run" },
        config: target.config,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      }),
    ).toEqual([]);
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
  ])("refuses a result captured before $name", async (replacement) => {
    const target = await createTarget();
    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      {
        sessionId: replacement.sessionId,
        lifecycleRevision: replacement.lifecycleRevision,
        updatedAt: 2,
      },
    );

    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: target.generation,
        text: "Do not append this stale cron result.",
        idempotencyKey: "cron-current-completion:cron:job-stale:3000",
        provenance: { kind: "cron", jobId: "job-stale", runId: "cron:job-stale:3000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("session rebound") });

    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: replacement.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("treats a missing lifecycle revision as exact generation state", async () => {
    const target = await createTarget();
    const generation = { sessionId: target.sessionId, lifecycleRevision: undefined };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      { sessionId: target.sessionId, updatedAt: 2 },
    );

    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: generation,
        text: "This still belongs to the revision-less session.",
        idempotencyKey: "cron-current-completion:cron:job-legacy:4000",
        provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:4000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: true });

    await replaceSessionEntry(
      { agentId: "main", sessionKey: target.sessionKey, storePath: target.storePath },
      { sessionId: target.sessionId, lifecycleRevision: "materialized-revision", updatedAt: 3 },
    );
    await expect(
      commitBackgroundResultToSession({
        agentId: "main",
        sessionKey: target.sessionKey,
        expectedGeneration: generation,
        text: "Do not append after the generation changes.",
        idempotencyKey: "cron-current-completion:cron:job-legacy:5000",
        provenance: { kind: "cron", jobId: "job-legacy", runId: "cron:job-legacy:5000" },
        config: target.config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("session rebound") });
  });
});
