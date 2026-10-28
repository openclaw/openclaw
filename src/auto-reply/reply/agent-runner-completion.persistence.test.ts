import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { renderStorageFailureSummary } from "../../agents/failover/assistant-request-failure-copy.js";
import * as utilityCompletion from "../../agents/utility-completion.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.transcript-turn.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { createSessionActivitySummaries } from "../../gateway/session-activity-summaries.js";
import type { defaultCompleteModel } from "../../gateway/session-observer-model.js";
import * as observerModel from "../../gateway/session-observer-model.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createAgentAccountingPersistenceFixture,
  observeCompletionCommands,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { touchQueuedReplySessionActivity } from "./agent-runner-session-activity.js";

let root: string;
let storePath: string;
let sequence = 0;
const operations: ReplyOperation[] = [];
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-completion-"));
  storePath = path.join(root, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
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
    registerOperation: (operation) => operations.push(operation),
  });
  if (withUsage) {
    fixture.setMeta({ usage: { input: 120, output: 8 } });
  }
  return fixture;
}

function observeCommands(options?: Parameters<typeof observeCompletionCommands>[0]) {
  const observer = observeCompletionCommands(options);
  return {
    ...observer,
    count: (command: string) => observer.commands.filter((entry) => entry === command).length,
    [Symbol.dispose]: () => observer.restore(),
  };
}

function lostStorageReply() {
  return new Error("Worker response lost", {
    cause: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
  });
}

function expectReconciliation(error: unknown) {
  expect(error).toHaveProperty("code", "outcome-unknown");
  const outcome = classifyGatewayStorageFailure(error);
  expect(outcome).toBe("session_actor_reconciliation");
  expect(renderStorageFailureSummary(outcome)).toMatch(/check.*history.*before trying again/i);
}

it.for(["ready", "late", "abandoned"] as const)(
  "persists a %s activity recap without holding up terminal accounting",
  async (timing, { signal }) => {
    const fixture = await createFixture(true);
    const sessionKey = fixture.context.sessionKey!;
    const cfg = {
      ...fixture.context.cfg,
      agents: { defaults: { utilityModel: "test/utility" } },
    };
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
    using auth = vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth");
    auth.mockResolvedValue(true);
    const prepare = vi.spyOn(observerModel, "defaultPrepareModel").mockResolvedValue({
      config: cfg,
      authProfileId: undefined,
      provider: "test",
      model: "utility",
      agentId: "main",
      agentDir: root,
      outputTextPolicy: "strict-visible",
      thinkLevel: "off",
    });
    const complete = vi
      .spyOn(observerModel, "defaultCompleteModel")
      .mockImplementation(async () => {
        started.resolve();
        return result.promise;
      });
    const service = createSessionActivitySummaries({
      scheduler,
      getConfig: () => cfg,
      onChanged() {
        if (fixture.read()?.activitySummary) {
          published.resolve();
        }
      },
    });
    const finishModel = () =>
      result.resolve({
        text: "Verified the change.",
        provider: "test",
        model: "utility",
        owner: { kind: "harness", id: "test" },
      });
    const completion = service.beginCompletion(
      { key: sessionKey, agentId: "main", storePath },
      fixture.read(),
    )!;
    fixture.context.activitySummaryCompletion = completion;
    using observer = observeCommands();
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
        expect(observer.count("session.actor.completeTurn")).toBe(1);
      }
      completion.release();
      finishModel();
      await withinTest(published.promise, signal);
      expect(fixture.read()?.activitySummary).toMatchObject({
        text: "Verified the change.",
        coveredMessages: 1,
      });
      expect(observer.count("session.entry.patch.commit")).toBe(timing === "ready" ? 0 : 1);
    } finally {
      completion.release();
      finishModel();
      await service.dispose();
      await scheduler.stop();
      prepare.mockRestore();
      complete.mockRestore();
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
    const invalidate = () =>
      sessionChanges.invalidate({
        sessionKey: fixture.context.sessionKey!,
        storePath,
        factsInvalidated: true,
      });
    let armed = stage === "initial";
    let invalidations = 0;
    const normalize = vi.fn<typeof fixture.context.replyMediaContext.normalizePayload>(
      async (payload) => {
        if (stage === "refresh") {
          invalidate();
          armed = true;
        }
        return payload;
      },
    );
    fixture.context.execution.result.payloads = [
      { text: "done", mediaUrl: "https://example.invalid/final.png" },
    ];
    fixture.context.replyMediaContext.normalizePayload = normalize;
    using observer = observeCommands({
      afterRead() {
        if (armed) {
          armed = false;
          // Cache-only invalidation does not revoke the unchanged scoped write token.
          for (let index = 0; index < count; index += 1) {
            invalidations += 1;
            invalidate();
          }
        }
      },
    });
    await expect(finalizeReplyAgentRun(fixture.context)).resolves.toMatchObject({ text: "done" });
    expect(invalidations).toBe(count);
    expect(normalize).toHaveBeenCalledOnce();
    expect(observer.count("session.actor.read")).toBe(stage === "initial" ? 1 : 2);
    expect(observer.count("session.actor.completeTurn")).toBe(1);
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
    using observer = observeCommands({
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
          sessionChanges.invalidate({
            sessionKey: fixture.context.sessionKey!,
            storePath,
            factsInvalidated: true,
          });
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

it.each(["unknown-commit", "unknown-storage-commit"] as const)(
  "does not disclose or replay a durable final after %s",
  async (failure) => {
    const fixture = await createFixture(true);
    using observer = observeCommands({
      hideCommittedReceipt: true,
      lostReplyError: failure === "unknown-storage-commit" ? lostStorageReply() : undefined,
    });
    const error = await finalizeReplyAgentRun(fixture.context).catch(
      (caughtError: unknown) => caughtError,
    );
    expect(error).toEqual(expect.any(Error));
    expect(error).toHaveProperty(
      "message",
      failure === "unknown-storage-commit"
        ? "Worker response lost"
        : "Unconfirmed actor settlement",
    );
    if (failure === "unknown-storage-commit") {
      expectReconciliation(error);
    }
    expect(observer.count("session.actor.completeTurn")).toBe(1);
    expect(fixture.read()).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      pendingFinalDelivery: {
        text: "done",
        deliveries: [{ state: "prepared" }],
      },
    });
  },
);

it("preserves storage guidance when queued activity loses its commit reply", async () => {
  const fixture = await createFixture();
  const original = fixture.context.activeSessionEntry!;
  const publish = vi.fn();
  using observer = observeCommands({
    hideCommittedReceipt: true,
    lostReplyError: lostStorageReply(),
  });
  const error = await touchQueuedReplySessionActivity(
    {
      followupRun: fixture.context.followupRun,
      sessionKey: fixture.context.sessionKey,
      sessionStore: fixture.context.activeSessionStore,
      storePath,
    },
    original,
    publish,
  ).catch((caughtError: unknown) => caughtError);
  expectReconciliation(error);
  expect(observer.count("session.actor.patch")).toBe(1);
  expect(fixture.read()?.updatedAt).toBeGreaterThan(original.updatedAt);
  expect(publish).not.toHaveBeenCalled();
  expect(fixture.context.activeSessionStore?.[fixture.context.sessionKey!]).toBe(original);
});

it("preserves usage-only failure semantics after a proven worker rollback", async () => {
  const fixture = await createFixture(true);
  const before = fixture.read();
  const beforeCommit = vi.fn(() => {
    throw new Error("synthetic completion refusal");
  });
  using observer = observeCommands({ beforeCommit });
  await expect(
    fixture.account("ordinary", { usage: { input: 120, output: 8 } }),
  ).resolves.toBeUndefined();
  expect(observer.count("session.actor.completeTurn")).toBe(1);
  expect(beforeCommit).toHaveBeenCalledOnce();
  expect(fixture.read()).toEqual(before);
});

it("rechecks the live reply operation at the final commit boundary", async () => {
  const fixture = await createFixture();
  const before = fixture.read();
  const beforeCommit = vi.fn(() => {
    fixture.context.replyOperation.complete();
  });
  using observer = observeCommands({ beforeCommit });
  await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
    "Terminal accounting lost its reply operation",
  );
  expect(observer.count("session.actor.completeTurn")).toBe(1);
  expect(beforeCommit).toHaveBeenCalledOnce();
  expect(fixture.read()).toEqual(before);
});
