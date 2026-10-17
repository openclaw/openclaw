import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.transcript-turn.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { createSessionActivitySummaries } from "../../gateway/session-activity-summaries.js";
import {
  activityRecapResult,
  preparedActivityRecapModel,
} from "../../gateway/session-activity-summaries.test-support.js";
import type { defaultCompleteModel } from "../../gateway/session-observer-model.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
  observeCompletionCommands,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";

let root: string;
let storePath: string;
let sequence = 0;
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-completion-"));
  storePath = path.join(root, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  await closeOpenClawAgentDatabasesAsync(root);
  fs.rmSync(root, { recursive: true, force: true });
});
async function createFixture(withUsage = false) {
  const fixture = await createAgentAccountingPersistenceFixture({
    storePath,
    root,
    fixtureId: ++sequence,
    registerOperation: (operation) => onTestFinished(() => operation.complete()),
  });
  if (withUsage) {
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
  }
  return fixture;
}

function invalidate(fixture: Awaited<ReturnType<typeof createFixture>>) {
  sessionChanges.invalidate({
    sessionKey: fixture.context.sessionKey!,
    storePath,
    factsInvalidated: true,
  });
}

function observeCommands(...args: Parameters<typeof observeCompletionCommands>) {
  const observer = observeCompletionCommands(...args);
  onTestFinished(() => observer.restore());
  return observer;
}

function expectCommands(
  observer: ReturnType<typeof observeCompletionCommands>,
  command = "session.actor.completeTurn",
  count = 1,
) {
  expect(observer.commands.filter((entry) => entry === command)).toHaveLength(count);
}

it.for(["ready", "late", "abandoned"] as const)(
  "persists a %s activity recap without holding up terminal accounting",
  async (timing, { signal }) => {
    const fixture = await createFixture(true);
    const sessionKey = fixture.context.sessionKey!;
    const cfg = { ...fixture.context.cfg, agents: { defaults: { utilityModel: "test/utility" } } };
    await persistSessionTranscriptTurn(
      { storePath, sessionKey, sessionId: fixture.sessionId, agentId: "main" },
      {
        messages: [
          { eventId: "request", message: { role: "user", content: "Verify the change." } },
        ],
        touchSessionEntry: false,
      },
    );
    const started = createDeferred();
    const result = createDeferred<Awaited<ReturnType<typeof defaultCompleteModel>>>();
    const published = createDeferred();
    const scheduler = createTestGatewayScheduler();
    const service = createSessionActivitySummaries({
      scheduler,
      getConfig: () => cfg,
      onChanged() {
        if (fixture.read()?.activitySummary) {
          published.resolve();
        }
      },
      prepareModel: async () => ({
        ...preparedActivityRecapModel,
        config: cfg,
        agentDir: root,
      }),
      completeModel: async () => {
        started.resolve();
        return result.promise;
      },
    });
    const finishModel = () => result.resolve(activityRecapResult("Verified the change."));
    const completion = service.beginCompletion(
      { key: sessionKey, agentId: "main", storePath },
      fixture.read(),
    )!;
    fixture.context.activitySummaryCompletion = completion;
    const observer = observeCompletionCommands();
    try {
      service.handleEvent({
        sessionKey,
        agentId: "main",
        runId: fixture.context.runId,
        seq: 1,
        ts: Date.now(),
        stream: "lifecycle",
        data: { phase: "end" },
      });
      await withinTest(started.promise, signal);
      if (timing !== "late") {
        finishModel();
        // Let the model's promise continuations offer their result before accounting starts.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fixture.read()?.activitySummary).toBeUndefined();
      }
      if (timing !== "abandoned") {
        await expect(finalizeReplyAgentRun(fixture.context)).resolves.toMatchObject({
          text: "done",
        });
        expect(fixture.read()).toMatchObject({ inputTokens: 120, outputTokens: 8 });
        expectCommands(observer);
      }
      completion.release();
      finishModel();
      await withinTest(published.promise, signal);
      expect(fixture.read()?.activitySummary).toMatchObject({
        text: "Verified the change.",
        coveredMessages: 1,
      });
      expectCommands(observer, "session.entry.patch.commit", timing === "ready" ? 0 : 1);
    } finally {
      completion.release();
      finishModel();
      await service.dispose();
      await scheduler.stop();
      observer.restore();
    }
  },
);

it.each([
  { stage: "initial", count: 1 },
  { stage: "refresh", count: 1 },
  { stage: "initial", count: 2 },
] as const)(
  "preserves the completed reply after $count cache-only invalidations during the $stage read",
  async ({ stage, count }) => {
    const fixture = await createFixture(true);
    let armed = stage === "initial";
    let invalidations = 0;
    const normalize = vi.fn<typeof fixture.context.replyMediaContext.normalizePayload>(
      async (payload) => {
        if (stage === "refresh") {
          invalidate(fixture);
          armed = true;
        }
        return payload;
      },
    );
    fixture.context.execution.result.payloads = [
      { text: "done", mediaUrl: "https://example.invalid/final.png" },
    ];
    fixture.context.replyMediaContext.normalizePayload = normalize;
    const observer = observeCommands({
      afterRead() {
        if (armed) {
          armed = false;
          // Cache-only invalidation does not revoke the unchanged scoped write token.
          for (let index = 0; index < count; index += 1) {
            invalidations += 1;
            invalidate(fixture);
          }
        }
      },
    });
    await expect(finalizeReplyAgentRun(fixture.context)).resolves.toMatchObject({ text: "done" });
    expect(invalidations).toBe(count);
    expect(normalize).toHaveBeenCalledOnce();
    expectCommands(observer, "session.actor.read", stage === "initial" ? 1 : 2);
    expectCommands(observer);
    const stored = fixture.read();
    expect(stored).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      pendingFinalDelivery: {
        text: "done\nMEDIA:https://example.invalid/final.png",
        deliveries: [{ state: "prepared" }],
      },
    });
  },
);

it.each(["unrelated-error", "writer-replaced"] as const)(
  "does not retry or publish a completed reply past %s",
  async (failure) => {
    const fixture = await createFixture();
    let reads = 0;
    let replacement: Promise<unknown> | undefined;
    const observer = observeCommands({
      afterRead() {
        reads += 1;
        if (failure === "unrelated-error") {
          // Identical text must not turn an unrelated failure into a retry signal.
          throw new Error("Session actor changed before its read could publish");
        }
        if (failure === "writer-replaced" && reads === 1) {
          replacement = runOutsideStoreWriterContext(() =>
            fixture.replace({
              ...fixture.context.activeSessionEntry!,
              activeWriterRunId: "replacement-writer",
            }),
          );
        }
        if (reads === 1) {
          invalidate(fixture);
        }
      },
    });
    await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
      failure === "writer-replaced"
        ? "Terminal accounting session changed"
        : "Session actor changed before its read could publish",
    );
    await replacement;
    // Replacement is rejected at admission before another worker read can execute.
    expect(reads).toBe(1);
    expect(observer.commands).not.toContain("session.actor.completeTurn");
    expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
    expect(fixture.read()?.inputTokens).toBeUndefined();
    if (failure === "writer-replaced") {
      expect(fixture.read()?.activeWriterRunId).toBe("replacement-writer");
    }
  },
);

it.each(["publication-failure", "unknown-commit"] as const)(
  "does not disclose or replay a durable final after %s",
  async (failure) => {
    const fixture = await createFixture(true);
    if (failure === "publication-failure") {
      fixture.context.activeSessionStore = Object.freeze({ ...fixture.context.activeSessionStore });
    }
    const observer = observeCommands({ hideCommittedReceipt: failure === "unknown-commit" });
    await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
      failure === "unknown-commit"
        ? "Unconfirmed actor settlement"
        : /read only|readonly|extensible/i,
    );
    expectCommands(observer);
    expect(fixture.read()).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      pendingFinalDelivery: { text: "done", deliveries: [{ state: "prepared" }] },
    });
  },
);

it.each(["usage-only", "with-final-custody", "operation-closed"] as const)(
  "preserves stored state when %s completion fails at the commit boundary",
  async (kind) => {
    const fixture = await createFixture(kind !== "operation-closed");
    const before = fixture.read();
    const beforeCommit = vi.fn(() => {
      if (kind === "operation-closed") {
        fixture.context.replyOperation.complete();
      } else {
        throw new Error("synthetic completion refusal");
      }
    });
    const observer = observeCommands({ beforeCommit });
    if (kind === "usage-only") {
      await expect(
        fixture.account("ordinary", fixture.context.execution.result.meta.agentMeta!),
      ).resolves.toBeUndefined();
    } else {
      await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
        kind === "operation-closed"
          ? "Terminal accounting lost its reply operation"
          : "synthetic completion refusal",
      );
    }
    expectCommands(observer);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(fixture.read()).toEqual(before);
  },
);
