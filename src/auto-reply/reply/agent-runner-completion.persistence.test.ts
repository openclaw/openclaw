import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.transcript-turn.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { createSessionActivitySummaries } from "../../gateway/session-activity-summaries.js";
import type { defaultCompleteModel } from "../../gateway/session-observer-model.js";
import * as observerModel from "../../gateway/session-observer-model.js";
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
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
  observeCompletionCommands,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";

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
function createFixture() {
  return createAgentAccountingPersistenceFixture({
    storePath,
    root,
    fixtureId: ++sequence,
    registerOperation: (operation) => operations.push(operation),
  });
}

it.for(["ready", "late", "abandoned"] as const)(
  "persists a %s activity recap without holding up terminal accounting",
  async (timing, { signal }) => {
    const fixture = await createFixture();
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
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
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
        expect(
          observer.commands.filter((command) => command === "session.actor.completeTurn"),
        ).toHaveLength(1);
      }
      completion.release();
      finishModel();
      await withinTest(published.promise, signal);
      expect(fixture.read()?.activitySummary).toMatchObject({
        text: "Verified the change.",
        coveredMessages: 1,
      });
      expect(
        observer.commands.filter((command) => command === "session.entry.patch.commit"),
      ).toHaveLength(timing === "ready" ? 0 : 1);
    } finally {
      completion.release();
      finishModel();
      await service.dispose();
      await scheduler.stop();
      observer.restore();
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
    const fixture = await createFixture();
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
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    const observer = observeCompletionCommands({
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
    try {
      await expect(finalizeReplyAgentRun(fixture.context)).resolves.toMatchObject({ text: "done" });
      expect(invalidations).toBe(count);
      expect(normalize).toHaveBeenCalledOnce();
      expect(observer.commands.filter((command) => command === "session.actor.read")).toHaveLength(
        stage === "initial" ? 1 : 2,
      );
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      const stored = fixture.read();
      expect(stored).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
        pendingFinalDelivery: {
          text: "done\nMEDIA:https://example.invalid/final.png",
          deliveries: [{ state: "prepared" }],
        },
      });
    } finally {
      observer.restore();
    }
  },
);

it.each(["unrelated-error", "writer-replaced"] as const)(
  "does not retry or publish a completed reply past %s",
  async (failure) => {
    const fixture = await createFixture();
    let reads = 0;
    let replacement: Promise<unknown> | undefined;
    const observer = observeCompletionCommands({
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
    try {
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
    } finally {
      observer.restore();
    }
  },
);

it.each(["publication-failure", "unknown-commit"] as const)(
  "does not disclose or replay a durable final after %s",
  async (failure) => {
    const fixture = await createFixture();
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    if (failure === "publication-failure") {
      fixture.context.activeSessionStore = Object.freeze({ ...fixture.context.activeSessionStore });
    }
    const observer = observeCompletionCommands({
      hideCommittedReceipt: failure === "unknown-commit",
    });
    try {
      await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
        failure === "unknown-commit"
          ? "Unconfirmed actor settlement"
          : /read only|readonly|extensible/i,
      );
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      expect(fixture.read()).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
        pendingFinalDelivery: {
          text: "done",
          deliveries: [{ state: "prepared" }],
        },
      });
    } finally {
      observer.restore();
    }
  },
);

it.each(["usage-only", "with-final-custody"] as const)(
  "preserves %s failure semantics after a proven worker rollback",
  async (kind) => {
    const fixture = await createFixture();
    const meta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    fixture.context.execution.result.meta.agentMeta = meta;
    const before = fixture.read();
    const beforeCommit = vi.fn(() => {
      throw new Error("synthetic completion refusal");
    });
    const observer = observeCompletionCommands({ beforeCommit });
    try {
      if (kind === "usage-only") {
        await expect(fixture.account("ordinary", meta)).resolves.toBeUndefined();
      } else {
        await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
          "synthetic completion refusal",
        );
      }
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      expect(beforeCommit).toHaveBeenCalledOnce();
      expect(fixture.read()).toEqual(before);
    } finally {
      observer.restore();
    }
  },
);

it("rechecks the live reply operation at the final commit boundary", async () => {
  const fixture = await createFixture();
  const before = fixture.read();
  const beforeCommit = vi.fn(() => {
    fixture.context.replyOperation.complete();
  });
  const observer = observeCompletionCommands({ beforeCommit });
  try {
    await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
      "Terminal accounting lost its reply operation",
    );
    expect(
      observer.commands.filter((command) => command === "session.actor.completeTurn"),
    ).toHaveLength(1);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(fixture.read()).toEqual(before);
  } finally {
    observer.restore();
  }
});
