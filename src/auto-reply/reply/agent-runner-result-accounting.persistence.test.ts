import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { getReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import { recordTurnCompaction } from "./agent-runner-compaction-accounting.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
  observeCompletionCommands,
  withAccountingProvider,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { registerAccountingReplacementRaceCases } from "./agent-runner-result-accounting.replacement.cases.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { createFollowupRunner } from "./followup-runner.js";
import * as followupExecution from "./followup-turn-execution.js";
import * as followupAdmission from "./reply-agent-turn-preparation.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";
import { incrementCompactionCount } from "./session-updates.js";
import { createMockTypingController } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const turnUsage = Object.freeze({ input: 120, output: 8 });
const persistedTurnUsage = { inputTokens: 120, outputTokens: 8 };
const operations: ReplyOperation[] = [];
let suiteRoot: string;
let storePath: string;
let fixtureSequence = 0;
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  suiteRoot = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-accounting-suite-"),
  );
  storePath = path.join(suiteRoot, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  await closeOpenClawAgentDatabasesAsync(suiteRoot);
  expect(isOpenClawAgentDatabaseOpen(storePath)).toBe(false);
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
async function createFixture(
  options: Partial<Parameters<typeof createAgentAccountingPersistenceFixture>[0]> = {},
) {
  const fixture = await createAgentAccountingPersistenceFixture({
    storePath,
    root: options.root ?? tempDirs.make("openclaw-context-pressure-"),
    fixtureId: ++fixtureSequence,
    registerOperation: (operation) => operations.push(operation),
    ...options,
  });
  return Object.assign(fixture, {
    patch: async (patch: Partial<SessionEntry>) => {
      const next = { ...fixture.read()!, ...patch };
      await fixture.replace(next);
      return next;
    },
  });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
function createRecoveryFixture(
  { context, sessionId, turn }: Fixture,
  admissionRunId: string,
  lane: "ordinary" | "followup" = "ordinary",
) {
  const scope = { agentId: "main", storePath, sessionKey: context.sessionKey! };
  const getSessionId = () => sessionId;
  const actor = createReplyRecoveryActorFixture({
    ...scope,
    getSessionId,
    operation: lane === "followup" ? turn.operation : context.replyOperation,
  });
  return Object.assign(actor, {
    controller: createReplyRestartRecoveryClaimController({
      ...scope,
      getEntry: () => (lane === "followup" ? turn.session.current() : context.activeSessionEntry),
      setEntry(next) {
        if (lane === "followup") {
          turn.session.publish(next);
        } else {
          context.activeSessionEntry = next;
          context.activeSessionStore![context.sessionKey!] = next;
        }
      },
      acquireSessionActor: () => actor.acquireSessionActor(),
      admissionRunId,
      executionRunId: lane === "followup" ? turn.runId : context.runId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getSessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
    }),
  });
}

function setTerminalReply(
  { context }: Fixture,
  kind: "NO_REPLY" | "empty" | "hook_block",
  expectation: "required" | "optional",
  message = "blocked",
) {
  context.followupRun.run.terminalReplyExpectation = expectation;
  context.execution.result.payloads = [];
  context.execution.result.meta.terminalReply = prepareAgentRunTerminalReply({
    rawText: kind === "NO_REPLY" ? "NO_REPLY" : "",
  }).terminalReply;
  if (kind === "NO_REPLY") {
    context.execution.result.meta.finalAssistantRawText = "NO_REPLY";
  } else if (kind === "hook_block") {
    context.execution.result.meta.error = { kind: "hook_block", message };
  }
}

async function finalizeWithMedia(fixture: Fixture, prepare: () => Promise<unknown>) {
  const { context } = fixture;
  context.execution.result.payloads = [
    { text: "done", mediaUrl: "https://example.invalid/final.png" },
  ];
  const normalizePayload = vi.fn(
    async (payload: Parameters<typeof context.replyMediaContext.normalizePayload>[0]) => {
      await prepare();
      return payload;
    },
  );
  context.replyMediaContext.normalizePayload = normalizePayload;
  await finalizeReplyAgentRun(context);
  expect(normalizePayload).toHaveBeenCalled();
}

it.each(["before-accounting", "during-payload-preparation"] as const)(
  "consolidates only the model switch present %s",
  async (when) => {
    const fixture = await createFixture();
    if (when === "before-accounting") {
      await fixture.patch({ liveModelSwitchPending: true });
    }
    await finalizeWithMedia(fixture, async () => {
      if (when === "during-payload-preparation") {
        await fixture.patch({ liveModelSwitchPending: true });
      }
    });
    expect(fixture.read()?.liveModelSwitchPending).toBe(
      when === "during-payload-preparation" ? true : undefined,
    );
  },
);

it("retains an accepted rejected followup's recovery claim until source delivery settles", async () => {
  const fixture = await createFixture();
  const { context, turn } = fixture;
  const entry = await fixture.patch({
    restartRecoveryDeliveryRunId: "accepted-followup",
    restartRecoveryDeliverySourceRunId: "accepted-source",
  });
  turn.session.publish(entry);
  await using actor = createRecoveryFixture(fixture, "accepted-followup", "followup");
  const recovery = actor.controller;
  await recovery.admitUserTurn();
  turn.restartRecovery = recovery;
  let deliveryEntry: SessionEntry | undefined;
  const deliver = vi.fn(async () => {
    deliveryEntry = fixture.read();
  });
  turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
  const admission = vi
    .spyOn(followupAdmission, "prepareReplyAgentTurn")
    .mockResolvedValue({ kind: "admitted", configured: undefined, turn });
  const execution = vi.spyOn(followupExecution, "executeFollowupTurn").mockResolvedValue({
    commentaryPayloadsEnabled: false,
    execution: {
      runId: turn.runId,
      outcome: { kind: "rejected", payload: { text: "Accepted setup failed", isError: true } },
    },
    runStartedAt: context.runStartedAt,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: async () => {} },
  });
  try {
    await withAccountingProvider(() =>
      createFollowupRunner({
        defaultModel: diagnostic.model,
        typing: createMockTypingController(),
        typingMode: "never",
      })(turn.queued),
    );
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        payloads: [expect.objectContaining({ text: "Accepted setup failed", isError: true })],
        completion: expect.objectContaining({ kind: "failed" }),
      }),
    );
    expect(deliveryEntry).toMatchObject({
      restartRecoveryDeliveryRunId: "accepted-followup",
      restartRecoveryDeliverySourceRunId: "accepted-source",
    });
    expect(deliveryEntry?.pendingFinalDelivery).toBeUndefined();
    expect(deliveryEntry?.restartRecoveryTerminalRunIds ?? []).not.toContain("accepted-source");
    const settledEntry = fixture.read();
    expect(settledEntry?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(settledEntry?.restartRecoveryTerminalRunIds).toContain("accepted-source");
  } finally {
    admission.mockRestore();
    execution.mockRestore();
  }
});

it.each([
  { name: "auth profile", authProfileOverride: "openai:new", authProfileOverrideSource: "user" },
  { name: "auth provenance", authProfileOverride: "openai:old", authProfileOverrideSource: "user" },
] as const)(
  "preserves a newer $name switch selected during payload preparation",
  async ({ authProfileOverride, authProfileOverrideSource }) => {
    const fixture = await createFixture();
    await fixture.patch({
      authProfileOverride: "openai:old",
      authProfileOverrideSource: "auto",
      liveModelSwitchPending: true,
    });
    await finalizeWithMedia(fixture, () =>
      fixture.patch({
        authProfileOverride,
        authProfileOverrideSource,
        liveModelSwitchPending: true,
      }),
    );
    expect(fixture.read()).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      authProfileOverride,
      authProfileOverrideSource,
      liveModelSwitchPending: true,
    });
  },
);

it("keeps incognito accounting and final custody on the retained memory owner", async () => {
  const root = tempDirs.make("openclaw-native-completion-");
  const env = { OPENCLAW_STATE_DIR: root };
  const nativePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const options = { agentId: "main", env, path: nativePath };
  try {
    const fixture = await createFixture({
      storePath: nativePath,
      incognito: true,
      root,
    });
    const owner = memorySessionActorOwners.read(options);
    expect(owner).toBeDefined();
    fixture.setMeta({ usage: turnUsage });
    const result = await finalizeReplyAgentRun(fixture.context);
    expect(result).toMatchObject({ text: "done" });
    const final = Array.isArray(result) ? result[0] : result;
    const completion = final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion;
    expect(completion).toMatchObject({
      sessionId: fixture.sessionId,
      sessionKey: fixture.context.sessionKey,
      storePath: nativePath,
    });
    expect(fixture.read()).toMatchObject({
      ...persistedTurnUsage,
      pendingFinalDelivery: {
        intentId: completion?.intentId,
        text: "done",
        deliveries: [{ id: completion?.deliveryId, state: "prepared" }],
      },
    });
    expect(memorySessionActorOwners.read(options)).toBe(owner);
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    expect(fs.existsSync(nativePath)).toBe(false);
  } finally {
    memorySessionActorOwners.closeDatabase(options);
  }
});

it("completes against the settled writer when the caller still has its pre-run entry", async () => {
  const fixture = await createFixture();
  fixture.context.execution.sessionWriter = {
    agentId: "main",
    storePath,
    sessionKey: fixture.context.sessionKey!,
    sessionId: fixture.sessionId,
    lifecycleRevision: fixture.context.activeSessionEntry!.lifecycleRevision,
    activeWriterRunId: fixture.context.runId,
  };
  Object.assign(fixture.context.activeSessionEntry!, { activeWriterRunId: undefined });

  const result = await finalizeReplyAgentRun(fixture.context);

  expect(result).toMatchObject({ text: "done" });
  expect(fixture.read()).toMatchObject({
    activeWriterRunId: fixture.context.runId,
    pendingFinalDelivery: { text: "done" },
  });
  expect(fixture.read()?.compactionCount).toBeUndefined();
});

it.each(["success", "publication-failure", "rollback"] as const)(
  "settles restart claim cleanup with final accounting after %s",
  async (outcome) => {
    const fixture = await createFixture();
    const { context } = fixture;
    const sessionKey = context.sessionKey!;
    const entry = await fixture.patch({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
    });
    context.activeSessionEntry = entry;
    context.activeSessionStore![sessionKey] = entry;
    await using actor = createRecoveryFixture(fixture, "recovery-run");
    const controller = actor.controller;
    await controller.admitUserTurn();
    const settled = await fixture.patch({
      status: "done" as const,
      endedAt: 1_000,
      updatedAt: 1_000,
    });
    context.activeSessionEntry = settled;
    context.activeSessionStore![sessionKey] = settled;
    context.prepareRestartClaimCleanup = controller.prepareCompletionCleanup;
    fixture.setMeta({ usage: turnUsage });
    const before = fixture.read();
    if (outcome === "publication-failure") {
      context.activeSessionStore = Object.freeze({ ...context.activeSessionStore });
    }
    const observer = observeCompletionCommands(
      outcome === "rollback"
        ? {
            beforeCommit() {
              throw new Error("synthetic completion refusal");
            },
          }
        : {},
    );
    const expected = {
      status: "done",
      endedAt: 1_000,
      updatedAt: 1_000,
      ...persistedTurnUsage,
      pendingFinalDelivery: { text: "done", deliveries: [{ state: "prepared" }] },
      restartRecoveryTerminalRunIds: ["source-turn"],
    };
    try {
      if (outcome === "success") {
        await finalizeReplyAgentRun(context);
      } else {
        await expect(finalizeReplyAgentRun(context)).rejects.toThrow(
          outcome === "rollback"
            ? "synthetic completion refusal"
            : /read only|readonly|extensible/i,
        );
      }
      if (outcome === "rollback") {
        expect(fixture.read()).toEqual(before);
      } else {
        expect(fixture.read()).toMatchObject(expected);
        expect(fixture.read()?.restartRecoveryDeliveryRunId).toBeUndefined();
      }
      const commandsBeforeCleanup = observer.commands.length;
      await controller.clear();
      if (outcome !== "rollback") {
        expect(observer.commands).toHaveLength(commandsBeforeCleanup);
      }
      expect(fixture.read()?.restartRecoveryDeliveryRunId).toBeUndefined();
      if (outcome === "success") {
        context.replyOperation.complete();
        await actor.release();
        await disposeOpenClawAgentDatabaseByPath(storePath);
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        expect(fixture.read()).toMatchObject(expected);
        expect(fixture.read()?.restartRecoveryDeliveryRunId).toBeUndefined();
      }
    } finally {
      observer.restore();
    }
  },
);

it.each([
  ["typed runtime", 1_000_000, "runtime", 1_000_000, "runtime"],
  ["source-less runtime", 512_000, undefined, 512_000, "runtime"],
  ["current model lookup", undefined, undefined, 1_000, "resolved-v1"],
  ["prior context fallback", undefined, undefined, 272_000, undefined],
] as const)(
  "persists %s context provenance through completion",
  async (name, tokens, source, expected, expectedSource) => {
    const fixture = await createFixture();
    const { context, turn } = fixture;
    if (name === "prior context fallback") {
      const previous = {
        ...context.activeSessionEntry!,
        model: "old-model",
        contextTokens: 272_000,
        contextTokensSource: "resolved" as const,
      };
      await fixture.replace(previous);
      context.activeSessionEntry = previous;
      turn.session.publish(previous);
      context.followupRun.run.model = "unlisted-model";
      context.execution.resolved.model = "unlisted-model";
    }
    await fixture.account("followup", {
      model: context.execution.resolved.model,
      agentHarnessId: "context-fixture",
      contextTokens: tokens,
      contextTokensSource: source,
    });
    expect(fixture.read()).toMatchObject({
      contextTokens: expected,
      agentHarnessId: "context-fixture",
    });
    expect(fixture.read()?.contextTokensSource).toBe(expectedSource);
  },
);

it.each([
  { lane: "ordinary", field: "sessionId" },
  { lane: "ordinary", field: "lifecycleRevision" },
  { lane: "followup", field: "sessionId" },
] as const)(
  "keeps $lane diagnostic refresh inside its captured $field",
  async ({ lane, field }) => {
    const fixture = await createFixture();
    const { context, turn } = fixture;
    const original = context.activeSessionEntry!;
    const replacement = {
      ...original,
      [field]: field === "sessionId" ? `${fixture.sessionId}-replacement` : "replacement",
      updatedAt: Date.now(),
      traceLevel: "on" as const,
      pluginDebugEntries: [{ pluginId: "replacement", lines: ["🔎 REPLACEMENT_DIAGNOSTIC"] }],
    };
    Object.assign(context.followupRun.run, { traceAuthorized: true, traceLevelOverride: "on" });
    context.activeSessionStore = turn.sessionStore;
    const reader = vi
      .spyOn(sessionAccessor, "loadSessionEntryReadOnly")
      .mockReturnValue(replacement);
    try {
      const result =
        lane === "ordinary" ? await finalizeReplyAgentRun(context) : await fixture.deliverQueued();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).not.toContain("REPLACEMENT_DIAGNOSTIC");
    } finally {
      reader.mockRestore();
      expect(turn.session.current()).toMatchObject({
        sessionId: original.sessionId,
        lifecycleRevision: original.lifecycleRevision,
      });
    }
  },
);

it.each([
  { kind: "NO_REPLY", expectation: "required", missing: false },
  { kind: "NO_REPLY", expectation: "optional", missing: false },
  { kind: "empty", expectation: "required", missing: true },
  { kind: "hook_block", expectation: "required", missing: false },
] as const)(
  "accounts for queued $expectation $kind completion despite trace",
  async ({ kind, expectation, missing }) => {
    const fixture = await createFixture();
    fixture.context.followupRun.run.traceAuthorized = true;
    fixture.context.followupRun.run.traceLevelOverride = "raw";
    setTerminalReply(fixture, kind, expectation);
    const delivered = await fixture.deliverQueued();
    if (missing) {
      expect(delivered.filter((payload) => payload.isError && payload.isStatusNotice)).toHaveLength(
        1,
      );
      expect(delivered.some((payload) => isReplyPayloadTerminalContent(payload))).toBe(false);
    } else {
      expect(delivered).toEqual([]);
    }
  },
);

it("keeps queued diagnostic supplements behind source send policy", async () => {
  const fixture = await createFixture();
  fixture.context.followupRun.run.traceAuthorized = true;
  fixture.context.followupRun.run.traceLevelOverride = "raw";
  fixture.turn.sendPolicy = "deny";
  expect(await fixture.deliverQueued()).toEqual([]);
});

it("accounts a completed compaction before an empty heartbeat skips reply preparation", async () => {
  const fixture = await createFixture();
  fixture.context.isHeartbeat = true;
  fixture.context.followupRun.run.terminalReplyExpectation = "optional";
  fixture.recordCompaction({ currentContextTokens: 40 });
  fixture.context.execution.result.payloads = [];
  fixture.setMeta({ compactionCount: 1, compactionTokensAfter: 40 });

  expect(await finalizeReplyAgentRun(fixture.context)).toBeUndefined();

  expect(fixture.read()).toMatchObject({
    sessionId: fixture.sessionId,
    compactionCount: 1,
    totalTokens: 40,
    totalTokensFresh: true,
  });
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
});

describe.each(["ordinary", "followup"] as const)("%s byte-compaction accounting", (lane) => {
  it.each([false, true])(
    "preserves suppression unless host history changed (%s)",
    async (hostCompactionCommitted) => {
      const fixture = await createFixture();
      const latch = { activeBytes: 60_000, sessionId: fixture.sessionId, maxBytes: 50_000 };
      await fixture.replace({
        ...fixture.context.activeSessionEntry!,
        transcriptByteCompactionLatch: latch,
      });
      const compaction = fixture.recordCompaction({ currentContextTokens: 40 });
      const fact = compaction.durable[0]!;
      compaction.durable = [];
      recordTurnCompaction(compaction, { ...fact, hostCompactionCommitted });
      // A later native fact from the same writer must retain the prior host rewrite.
      recordTurnCompaction(compaction, fact);

      await fixture.account(lane, { compactionCount: 2, usage: { input: 120 } });

      expect(fixture.read()?.transcriptByteCompactionLatch).toEqual(
        hostCompactionCommitted ? undefined : latch,
      );
    },
  );
});

it.each([
  { completion: "NO_REPLY", expectation: "required", missing: false },
  { completion: "empty", expectation: "required", missing: true },
  { completion: "hook_block", expectation: "required", missing: false },
] as const)(
  "finalizes a $expectation $completion fallback without hiding missing output",
  async ({ completion, expectation, missing }) => {
    const fixture = await createFixture();
    const { context } = fixture;
    setTerminalReply(fixture, completion, expectation, "Reply suppressed");
    const onAgentRunTerminalOutcome = vi.fn();
    context.opts = { onAgentRunTerminalOutcome };
    context.execution.resolved = { provider: "fallback-provider", model: "fallback-model" };
    context.execution.fallback.attempts = [
      { provider: diagnostic.provider, model: diagnostic.model, reason: "auth", error: "No login" },
    ];

    const result = await finalizeReplyAgentRun(context);
    context.replyOperation.complete();

    if (missing) {
      expect(result).toMatchObject({
        isError: true,
        text: expect.any(String),
      });
      expect(context.replyOperation.result).toMatchObject({ kind: "failed", code: "run_failed" });
      expect(onAgentRunTerminalOutcome).toHaveBeenCalledWith("failed");
    } else {
      expect(result).toBeUndefined();
      expect(context.replyOperation.result).toEqual({ kind: "completed" });
      expect(onAgentRunTerminalOutcome).not.toHaveBeenCalledWith("failed");
    }
    expect(fixture.read()?.fallbackNotice).toMatchObject({
      kind: "active",
      activeModel: "fallback-provider/fallback-model",
    });
    expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
  },
);

describe("cancelled followup compaction accounting", () => {
  it("retains committed compaction facts after restart abort without success bookkeeping", async () => {
    const fixture = await createFixture();
    const original = {
      ...fixture.context.activeSessionEntry!,
      compactionCount: 3,
      groupActivationNeedsSystemIntro: true,
      ...persistedTurnUsage,
      cacheRead: 20,
      cacheWrite: 4,
    };
    await fixture.replace(original);
    Object.assign(fixture.context.activeSessionEntry!, original);

    expect(await fixture.accountAborted("restart")).toBeUndefined();

    expect(fixture.read()).toMatchObject({
      sessionId: fixture.sessionId,
      lifecycleRevision: "generation-1",
      compactionCount: 4,
      totalTokens: 40,
      totalTokensFresh: true,
      groupActivationNeedsSystemIntro: true,
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
    });
    // Cancellation preserves committed compaction, not the previous run snapshot.
    for (const entry of [
      fixture.read(),
      fixture.context.activeSessionStore?.[fixture.context.sessionKey!],
    ]) {
      expect(entry?.inputTokens).toBeUndefined();
      expect(entry?.outputTokens).toBeUndefined();
      expect(entry?.cacheRead).toBeUndefined();
      expect(entry?.cacheWrite).toBeUndefined();
      expect(entry?.estimatedCostUsd).toBeUndefined();
    }
    expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
  });

  it("accounts cancellation against the committed successor despite a predecessor cache", async () => {
    const fixture = await createFixture();
    const sessionId = `${fixture.sessionId}-accepted-successor`;
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      sessionId,
      compactionCount: 3,
    });
    fixture.recordCompaction({ sessionId, currentContextTokens: 40 });
    fixture.context.replyOperation.updateSessionId(sessionId);
    expect(fixture.context.activeSessionEntry?.sessionId).toBe(fixture.sessionId);

    await fixture.accountAborted("user");

    expect(fixture.read()).toMatchObject({ sessionId, compactionCount: 4, totalTokens: 40 });
  });

  it("rejects a late old operation even when a replacement reuses its writer string", async () => {
    const fixture = await createFixture();
    fixture.recordCompaction({ currentContextTokens: 40 });
    fixture.context.replyOperation.complete();
    const replacement = createReplyOperation({
      sessionId: fixture.sessionId,
      sessionKey: fixture.context.sessionKey!,
      resetTriggered: false,
    });
    operations.push(replacement);
    const before = fixture.read();

    await fixture.accountAborted("user");

    expect(fixture.read()).toEqual(before);
  });
});
describe("followup context-pressure accounting", () => {
  const lane = "followup";
  it.each([true, false])(
    "records runtime-selected models without inventing host fallback (owned: %s)",
    async (runtimeOwned) => {
      const fixture = await createFixture();
      const outer = { provider: "outer-provider", model: "outer-model" };
      const selection = {
        provider: diagnostic.provider,
        model: runtimeOwned ? "native-selected-model" : diagnostic.model,
      };
      const models = fixture.context.cfg.models!.providers!.openai!.models;
      models.push({
        ...models[0]!,
        id: "native-selected-model",
        cost: { input: 10, output: 20, cacheRead: 5, cacheWrite: 10 },
      });
      Object.assign(fixture.context.followupRun.run, outer);
      const entry = fixture.context.activeSessionEntry!;
      Object.assign(entry, { modelProvider: outer.provider, model: outer.model });
      await fixture.replace(entry);

      await fixture.account(lane, {
        provider: diagnostic.provider,
        model: diagnostic.model,
        agentHarnessId: "codex",
        ...(runtimeOwned ? { runtimeModelSelection: selection } : {}),
        usage: turnUsage,
      });

      const persisted = fixture.read();
      expect(persisted?.fallbackNotice === undefined).toBe(runtimeOwned);
      expect(persisted).toMatchObject({
        modelProvider: runtimeOwned ? selection.provider : outer.provider,
        model: runtimeOwned ? selection.model : outer.model,
        ...persistedTurnUsage,
        estimatedCostUsd: 0.000136,
      });
      if (runtimeOwned) {
        expect(persisted?.agentHarnessId).toBe("codex");
      }
    },
  );

  it("does not infer a durable target from publisher compaction metadata", async () => {
    const fixture = await createFixture();
    fixture.context.execution.autoCompactionCount = 2;
    fixture.context.execution.compaction = { count: 2, durable: [] };

    await fixture.account(lane, {
      sessionId: `${fixture.sessionId}-unverified-successor`,
      compactionCount: 2,
      compactionTokensAfter: 40,
      usage: turnUsage,
      lastCallUsage: turnUsage,
      promptTokens: 120,
    });

    expect(fixture.read()?.sessionId).toBe(fixture.sessionId);
    expect(fixture.read()?.compactionCount).toBeUndefined();
    expect(fixture.read()?.totalTokens).toBeUndefined();
    expect(fixture.read()).toMatchObject({
      totalTokensFresh: false,
      ...persistedTurnUsage,
    });
  });

  it("persists new diagnostic with usage without changing token/cost accounting", async () => {
    const fixture = await createFixture();
    const usage = { ...turnUsage, cacheRead: 20 };
    await fixture.account(lane, { usage, lastCallUsage: usage, contextBudgetStatus: diagnostic });
    expect(fixture.read()?.contextBudgetStatus).toEqual(diagnostic);
    expect(fixture.read()).toMatchObject({
      ...persistedTurnUsage,
      cacheRead: 20,
      totalTokens: 140,
      totalTokensFresh: true,
      estimatedCostUsd: 0.000146,
    });
  });

  it("preserves diagnostics for exhausted fallback with usage", async () => {
    const fixture = await createFixture();
    fixture.context.execution.fallback.exhausted = true;
    const before = fixture.read()?.contextBudgetStatus;
    await fixture.account(lane, { usage: { input: 120 } });
    expect(fixture.read()?.contextBudgetStatus).toEqual(before);
  });

  it.each(["session", "context-pressure-successor"])(
    "accounts current-generation compaction into accepted %s",
    async (target) => {
      const fixture = await createFixture();
      const sessionId =
        target === "session"
          ? fixture.sessionId
          : `${fixture.sessionId}-context-pressure-successor`;
      fixture.recordCompaction({ sessionId, currentContextTokens: 120 });
      const successor = { ...fixture.context.activeSessionEntry!, sessionId };
      await fixture.replace(successor);
      fixture.context.activeSessionEntry = successor;
      fixture.turn.session.publish(successor);
      fixture.context.replyOperation.updateSessionId(sessionId);
      await fixture.account(lane, {
        sessionId,
        compactionCount: 1,
        usage: { input: 120 },
        lastCallUsage: { input: 120 },
      });
      expect(fixture.read()?.contextBudgetStatus).toBeUndefined();
      expect(fixture.read()).toMatchObject({
        sessionId,
        lifecycleRevision: "generation-1",
        compactionCount: 1,
        totalTokens: 120,
        totalTokensFresh: true,
        estimatedCostUsd: 0.00012,
      });
    },
  );
});

it("records an unavailable diagnostic after preflight compaction without usage", async () => {
  const fixture = await createFixture();
  await incrementCompactionCount({
    sessionEntry: fixture.context.activeSessionEntry,
    sessionStore: fixture.context.activeSessionStore,
    sessionKey: fixture.context.sessionKey,
    storePath: fixture.context.storePath,
    amount: 1,
    tokensAfter: 40,
  });
  expect(fixture.read()?.contextBudgetStatus).toBeUndefined();
  fixture.context.preflightCompactionApplied = true;
  await fixture.account("ordinary", { contextBudgetStatus: undefined });
  expect(fixture.read()?.contextBudgetStatus).toBeUndefined();
  expect(fixture.read()).toMatchObject({
    totalTokens: 40,
    totalTokensFresh: true,
    compactionCount: 1,
  });
});

registerAccountingReplacementRaceCases(createFixture);
