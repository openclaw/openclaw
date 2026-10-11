import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { applySessionEntryLifecycleMutation } from "../../config/sessions/session-accessor.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { getReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import { recordTurnCompaction } from "./agent-runner-compaction-accounting.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { incrementCompactionCount } from "./session-updates.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
function createFixture() {
  return createAgentAccountingPersistenceFixture({
    storePath,
    root: tempDirs.make("openclaw-context-pressure-"),
    fixtureId: ++fixtureSequence,
    registerOperation: (operation) => {
      operations.push(operation);
    },
  });
}

it.each(["before-accounting", "during-payload-preparation"] as const)(
  "consolidates only the model switch present %s",
  async (when) => {
    const fixture = await createFixture();
    fixture.context.execution.result.payloads = [
      { text: "done", mediaUrl: "https://example.invalid/final.png" },
    ];
    let payloadPrepared = false;
    fixture.context.replyMediaContext.normalizePayload = async (payload) => {
      payloadPrepared = true;
      if (when === "during-payload-preparation") {
        await fixture.replace({ ...fixture.read()!, liveModelSwitchPending: true });
      }
      return payload;
    };
    if (when === "before-accounting") {
      await fixture.replace({
        ...fixture.context.activeSessionEntry!,
        liveModelSwitchPending: true,
      });
    }
    await finalizeReplyAgentRun(fixture.context);
    expect(payloadPrepared).toBe(true);
    expect(fixture.read()?.liveModelSwitchPending).toBe(
      when === "during-payload-preparation" ? true : undefined,
    );
  },
);

it.each([
  { name: "auth profile", authProfileOverride: "openai:new", authProfileOverrideSource: "user" },
  { name: "auth provenance", authProfileOverride: "openai:old", authProfileOverrideSource: "user" },
] as const)(
  "preserves a newer $name switch selected during payload preparation",
  async ({ authProfileOverride, authProfileOverrideSource }) => {
    const fixture = await createFixture();
    fixture.context.execution.result.payloads = [
      { text: "done", mediaUrl: "https://example.invalid/final.png" },
    ];
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      authProfileOverride: "openai:old",
      authProfileOverrideSource: "auto",
      liveModelSwitchPending: true,
    });
    let payloadPrepared = false;
    fixture.context.replyMediaContext.normalizePayload = async (payload) => {
      payloadPrepared = true;
      await fixture.replace({
        ...fixture.read()!,
        authProfileOverride,
        authProfileOverrideSource,
        liveModelSwitchPending: true,
      });
      return payload;
    };

    await finalizeReplyAgentRun(fixture.context);

    expect(payloadPrepared).toBe(true);
    expect(fixture.read()).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      authProfileOverride,
      authProfileOverrideSource,
      liveModelSwitchPending: true,
    });
  },
);

it("keeps native incognito accounting and final custody on the retained memory owner", async () => {
  const root = tempDirs.make("openclaw-native-completion-");
  const env = { OPENCLAW_STATE_DIR: root };
  const nativePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const options = { agentId: "main", env, path: nativePath };
  const owner = openOpenClawAgentDatabase(options);
  try {
    const fixture = await createAgentAccountingPersistenceFixture({
      storePath: nativePath,
      root,
      fixtureId: ++fixtureSequence,
      registerOperation: (operation) => operations.push(operation),
    });
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
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
      inputTokens: 120,
      outputTokens: 8,
      pendingFinalDelivery: {
        intentId: completion?.intentId,
        text: "done",
        deliveries: [{ id: completion?.deliveryId, state: "prepared" }],
      },
    });
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(owner);
    expect(fs.existsSync(nativePath)).toBe(false);
  } finally {
    await disposeOpenClawAgentDatabaseByPath(nativePath);
  }
});

it("publishes a prepared final only after its worker completion commits without host transactions", async () => {
  const fixture = await createFixture();
  const payload = { text: "durable final" };
  fixture.context.execution.result.payloads = [payload];
  const sql = observeHostDataSql();
  try {
    const result = await finalizeReplyAgentRun(fixture.context);
    expect(result).toMatchObject({ text: "durable final" });
    expect(
      sql.queries.filter((query) =>
        /\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/i.test(query),
      ),
    ).toEqual([]);
    const final = Array.isArray(result) ? result[0] : result;
    const completion = final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion;
    expect(completion).toMatchObject({
      sessionId: fixture.sessionId,
      sessionKey: fixture.context.sessionKey,
      storePath,
    });
    expect(fixture.read()?.pendingFinalDelivery).toMatchObject({
      intentId: completion?.intentId,
      deliveries: [{ id: completion?.deliveryId, state: "prepared" }],
      text: "durable final",
    });
  } finally {
    sql.restore();
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

function observeCompletionCommands(
  options: { hideCommittedReceipt?: boolean; beforeCommit?: () => void } = {},
) {
  const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
  const commands: string[] = [];
  const execution = vi
    .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const owner = capture(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, run, runOptions) =>
          owner.runExisting(
            source,
            (worker) =>
              run({
                execute(command, commandOptions) {
                  commands.push(command.type);
                  return worker.execute(command, commandOptions);
                },
              }),
            runOptions,
          ),
      };
    });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((authorize, attachment) => {
      let terminalCommit = false;
      const owner = createAdmission((request, grant) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-actor-admission" &&
          request.facts.publication.final === true
        ) {
          terminalCommit = true;
          options.beforeCommit?.();
        }
        return authorize(request, grant);
      }, attachment);
      if (options.hideCommittedReceipt) {
        const committed = Object.getOwnPropertyDescriptor(owner, "committed")!;
        Object.defineProperty(owner, "committed", {
          get() {
            const receipt = committed.get!.call(owner);
            return terminalCommit ? undefined : receipt;
          },
        });
      }
      return owner;
    });
  return {
    commands,
    restore() {
      admission.mockRestore();
      execution.mockRestore();
    },
  };
}

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

it.each([
  { name: "typed runtime", tokens: 1_000_000, source: "runtime" as const, expected: 1_000_000 },
  { name: "source-less runtime", tokens: 512_000, source: undefined, expected: 512_000 },
  { name: "current model lookup", tokens: undefined, source: undefined, expected: 1_000 },
  { name: "prior context fallback", tokens: undefined, source: undefined, expected: 272_000 },
])(
  "persists $name context provenance through completion",
  async ({ name, tokens, source, expected }) => {
    const fixture = await createFixture();
    if (name === "prior context fallback") {
      const previous = {
        ...fixture.context.activeSessionEntry!,
        model: "old-model",
        contextTokens: 272_000,
        contextTokensSource: "resolved" as const,
      };
      await fixture.replace(previous);
      fixture.context.activeSessionEntry = previous;
      fixture.turn.session.adopt(previous);
      fixture.context.followupRun.run.model = "unlisted-model";
      fixture.context.execution.resolved.model = "unlisted-model";
    }
    await fixture.account("followup", {
      model: fixture.context.execution.resolved.model,
      agentHarnessId: "context-fixture",
      contextTokens: tokens,
      contextTokensSource: source,
    });
    expect(fixture.read()).toMatchObject({
      contextTokens: expected,
      agentHarnessId: "context-fixture",
    });
    expect(fixture.read()?.contextTokensSource).toBe(
      name === "current model lookup"
        ? "resolved-v1"
        : name === "prior context fallback"
          ? undefined
          : "runtime",
    );
  },
);

it.each([
  { stored: "off", selected: "raw", authorized: true, trace: true },
  { stored: "raw", selected: "off", authorized: true, trace: false },
  { stored: "raw", selected: undefined, authorized: true, trace: true },
  { stored: "off", selected: "raw", authorized: false, trace: false },
] as const)(
  "delivers queued trace $selected over stored $stored with authority=$authorized",
  async ({ stored, selected, authorized, trace }) => {
    const fixture = await createFixture();
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      traceLevel: stored,
      verboseLevel: "off",
    });
    fixture.context.followupRun.prompt = "QUEUED_INPUT";
    fixture.context.followupRun.run.traceAuthorized = authorized;
    fixture.context.followupRun.run.traceLevelOverride = selected;
    const delivered = await fixture.deliverQueued();
    expect(delivered.some((payload) => payload.text === "done")).toBe(true);
    const diagnostics = delivered.find((payload) =>
      payload.text?.includes("Model Input (User Role)"),
    );
    expect(Boolean(diagnostics)).toBe(trace);
    if (diagnostics) {
      expect(diagnostics.text).toContain("QUEUED_INPUT");
      expect(isReplyPayloadTerminalContent(diagnostics)).toBe(false);
    }
    expect(fixture.read()?.traceLevel).toBe(stored);
  },
);

describe.each(["ordinary", "followup"] as const)("%s completion verbosity", (lane) => {
  it.each([
    { initial: "on", live: "off", override: "on", visible: true },
    { initial: "off", live: "on", override: "off", visible: false },
  ] as const)(
    "uses live $live after $initial unless the turn selects $override",
    async ({ initial, live, override, visible }) => {
      const fixture = await createFixture();
      const entry = fixture.context.activeSessionEntry!;
      entry.verboseLevel = initial;
      fixture.context.resolvedVerboseLevel = override ?? initial;
      fixture.context.followupRun.run.verboseLevel = override ?? initial;
      fixture.context.followupRun.run.verboseLevelOverride = override;
      fixture.context.followupRun.run.traceAuthorized = false;
      await fixture.replace({
        ...entry,
        verboseLevel: live,
        pluginDebugEntries: [{ pluginId: "synthetic", lines: ["LIVE_VERBOSE_STATUS"] }],
      });
      const result =
        lane === "ordinary"
          ? await finalizeReplyAgentRun(fixture.context)
          : await fixture.deliverQueued();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).toContain("done");
      expect(text.includes("LIVE_VERBOSE_STATUS")).toBe(visible);
      expect(fixture.read()?.verboseLevel).toBe(live);
    },
  );
});

it.each([
  { lane: "ordinary", field: "sessionId" },
  { lane: "ordinary", field: "lifecycleRevision" },
  { lane: "followup", field: "sessionId" },
] as const)(
  "keeps $lane diagnostic refresh inside its captured $field",
  async ({ lane, field }) => {
    const fixture = await createFixture();
    const original = fixture.context.activeSessionEntry!;
    const replacement = {
      ...original,
      [field]: field === "sessionId" ? `${fixture.sessionId}-replacement` : "replacement",
      updatedAt: Date.now(),
      traceLevel: "on" as const,
      pluginDebugEntries: [{ pluginId: "replacement", lines: ["🔎 REPLACEMENT_DIAGNOSTIC"] }],
    };
    fixture.context.followupRun.run.traceAuthorized = true;
    fixture.context.followupRun.run.traceLevelOverride = "on";
    fixture.context.activeSessionStore = fixture.turn.sessionStore;
    const reader = vi
      .spyOn(sessionAccessor, "loadSessionEntryReadOnly")
      .mockReturnValue(replacement);
    try {
      const result =
        lane === "ordinary"
          ? await finalizeReplyAgentRun(fixture.context)
          : await fixture.deliverQueued();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).not.toContain("REPLACEMENT_DIAGNOSTIC");
    } finally {
      reader.mockRestore();
      expect(fixture.turn.session.current()).toMatchObject({
        sessionId: original.sessionId,
        lifecycleRevision: original.lifecycleRevision,
      });
    }
  },
);

it.each([
  { kind: "NO_REPLY", expectation: "required", missing: true },
  { kind: "NO_REPLY", expectation: "optional", missing: false },
  { kind: "hook_block", expectation: "required", missing: false },
] as const)(
  "accounts for queued $expectation $kind completion despite trace",
  async ({ kind, expectation, missing }) => {
    const fixture = await createFixture();
    fixture.context.followupRun.run.traceAuthorized = true;
    fixture.context.followupRun.run.traceLevelOverride = "raw";
    fixture.context.followupRun.run.terminalReplyExpectation = expectation;
    fixture.context.execution.result.payloads = [];
    if (kind === "NO_REPLY") {
      fixture.context.execution.result.meta.finalAssistantRawText = "NO_REPLY";
    } else {
      fixture.context.execution.result.meta.error = { kind: "hook_block", message: "blocked" };
    }
    const delivered = await fixture.deliverQueued();
    if (missing) {
      expect(
        delivered.some((payload) => payload.isError && isReplyPayloadTerminalContent(payload)),
      ).toBe(true);
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

it("accounts a completed compaction before an empty internal event skips reply preparation", async () => {
  const fixture = await createFixture();
  fixture.context.followupRun.run.inputProvenance = { kind: "internal_system", sourceTool: "cron" };
  fixture.context.followupRun.run.terminalReplyExpectation = "optional";
  fixture.recordCompaction({ currentContextTokens: 40 });
  fixture.context.execution.result.payloads = [];
  fixture.context.execution.result.meta.agentMeta = {
    sessionId: fixture.sessionId,
    provider: diagnostic.provider,
    model: diagnostic.model,
    compactionCount: 1,
    compactionTokensAfter: 40,
  };

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
  { completion: "NO_REPLY", expectation: "required", missing: true },
  { completion: "hook_block", expectation: "required", missing: false },
] as const)(
  "finalizes a $expectation $completion fallback without hiding missing output",
  async ({ completion, expectation, missing }) => {
    const fixture = await createFixture();
    const { context } = fixture;
    context.followupRun.run.terminalReplyExpectation = expectation;
    const onAgentRunTerminalOutcome = vi.fn();
    context.opts = { onAgentRunTerminalOutcome };
    context.execution.resolved = { provider: "fallback-provider", model: "fallback-model" };
    context.execution.fallback.attempts = [
      { provider: diagnostic.provider, model: diagnostic.model, reason: "auth", error: "No login" },
    ];
    context.execution.result.payloads = [];
    if (completion === "NO_REPLY") {
      context.execution.result.meta.finalAssistantRawText = "NO_REPLY";
    } else if (completion === "hook_block") {
      context.execution.result.meta.error = { kind: "hook_block", message: "Reply suppressed" };
    }

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
  it.each(["restart"] as const)(
    "retains committed compaction facts after %s abort without success bookkeeping",
    async (reason) => {
      const fixture = await createFixture();
      const original = {
        ...fixture.context.activeSessionEntry!,
        compactionCount: 3,
        groupActivationNeedsSystemIntro: true,
        inputTokens: 120,
        outputTokens: 8,
        cacheRead: 20,
        cacheWrite: 4,
      };
      await fixture.replace(original);
      Object.assign(fixture.context.activeSessionEntry!, original);

      expect(await fixture.accountAborted(reason)).toBeUndefined();

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
    },
  );

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
  it.each([
    { runtimeOwned: true, finalizer: true },
    { runtimeOwned: false, finalizer: false },
  ])(
    "records runtime-selected models without inventing host fallback (owned: $runtimeOwned, finalizer: $finalizer)",
    async ({ runtimeOwned, finalizer }) => {
      const fixture = await createFixture();
      const outer = { provider: "outer-provider", model: "outer-model" };
      const selection = {
        provider: diagnostic.provider,
        model: finalizer ? "native-selected-model" : diagnostic.model,
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
        usage: { input: 120, output: 8 },
      });

      const persisted = fixture.read();
      expect(persisted?.fallbackNotice === undefined).toBe(runtimeOwned);
      expect(persisted).toMatchObject({
        modelProvider: runtimeOwned ? selection.provider : outer.provider,
        model: runtimeOwned ? selection.model : outer.model,
        inputTokens: 120,
        outputTokens: 8,
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
      usage: { input: 120, output: 8 },
      lastCallUsage: { input: 120, output: 8 },
      promptTokens: 120,
    });

    expect(fixture.read()?.sessionId).toBe(fixture.sessionId);
    expect(fixture.read()?.compactionCount).toBeUndefined();
    expect(fixture.read()?.totalTokens).toBeUndefined();
    expect(fixture.read()).toMatchObject({
      totalTokensFresh: false,
      inputTokens: 120,
      outputTokens: 8,
    });
  });

  it.each([
    { name: "new diagnostic with usage", withUsage: true, contextBudgetStatus: diagnostic },
  ])(
    "persists $name without changing token/cost accounting",
    async ({ withUsage, contextBudgetStatus }) => {
      const fixture = await createFixture();
      const usage = withUsage ? { input: 120, output: 8, cacheRead: 20 } : undefined;
      const meta = { usage, lastCallUsage: usage, contextBudgetStatus };
      await fixture.account(lane, meta);
      expect(fixture.read()?.contextBudgetStatus).toEqual(contextBudgetStatus);
      expect(fixture.read()).toMatchObject(
        withUsage
          ? {
              inputTokens: 120,
              outputTokens: 8,
              cacheRead: 20,
              totalTokens: 140,
              totalTokensFresh: true,
              estimatedCostUsd: 0.000146,
            }
          : { totalTokensFresh: false, estimatedCostUsd: 2 },
      );
    },
  );

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
      fixture.turn.session.adopt(successor);
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

it.each([{ name: "unavailable", contextBudgetStatus: undefined }])(
  "records a $name diagnostic after preflight compaction without usage",
  async ({ contextBudgetStatus }) => {
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
    await fixture.account("ordinary", { contextBudgetStatus });
    expect(fixture.read()?.contextBudgetStatus).toEqual(contextBudgetStatus);
    expect(fixture.read()).toMatchObject({
      totalTokens: 40,
      totalTokensFresh: true,
      compactionCount: 1,
    });
  },
);

describe.each(["ordinary", "followup"] as const)("%s accounting replacement races", (lane) => {
  it.each([
    { name: "session", replacement: { sessionId: "replacement-session" } },
    { name: "lifecycle", replacement: { lifecycleRevision: "generation-2" } },
    { name: "writer", replacement: { activeWriterRunId: "newer-writer" } },
  ])(
    "does not compact replacement $name telemetry after the old owner resumes",
    async ({ name, replacement }) => {
      const fixture = await createFixture();
      fixture.recordCompaction();
      const pendingTool = createDeferred();
      fixture.context.pendingToolTasks.add(pendingTool.promise);
      const accounting = fixture.account(lane, {
        compactionCount: 1,
        usage: { input: 120 },
        lastCallUsage: { input: 120 },
      });
      // Simulate an old closure surviving forced terminal-settlement release.
      // Normal competing reset/delete waits for admission; this is the resumed
      // owner's write fence after replacement, not a claim that reset bypasses it.
      const next: SessionEntry = {
        ...fixture.context.activeSessionEntry!,
        ...(name === "session" ? { sessionId: `${fixture.sessionId}-replacement` } : replacement),
        updatedAt: 30,
        contextBudgetStatus: {
          ...diagnostic,
          updatedAt: 30,
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 100,
          remainingPromptBudgetTokens: 800,
          overflowTokens: 0,
        },
        compactionCount: 9,
        totalTokens: 666,
        totalTokensFresh: true,
        inputTokens: 500,
        outputTokens: 70,
        cacheRead: 50,
        cacheWrite: 5,
        estimatedCostUsd: 7,
      };
      await fixture.replace(next);
      const persisted = fixture.read();
      pendingTool.resolve();
      await expect(accounting).rejects.toThrow("Terminal accounting session changed");
      expect(fixture.read()).toEqual(persisted);
    },
  );

  it("keeps the admitted generation while pending tool work drains", async () => {
    const fixture = await createFixture();
    const pendingTool = createDeferred();
    fixture.context.pendingToolTasks.add(pendingTool.promise);
    const accounting = fixture.account(lane, { usage: { input: 120 } });
    const replacement = {
      ...fixture.context.activeSessionEntry!,
      lifecycleRevision: "generation-2",
      contextBudgetStatus: undefined,
    };
    await fixture.replace(replacement);
    Object.assign(fixture.context.activeSessionEntry!, replacement);
    const persisted = fixture.read();
    pendingTool.resolve();
    await expect(accounting).rejects.toThrow("Terminal accounting session changed");
    expect(fixture.read()).toEqual(persisted);
  });

  it("does not recreate a deleted session while accounting a completed result", async () => {
    const fixture = await createFixture();
    await applySessionEntryLifecycleMutation({
      storePath: fixture.context.storePath!,
      removals: [{ sessionKey: fixture.context.sessionKey! }],
      skipMaintenance: true,
    });
    await expect(fixture.account(lane, { usage: { input: 120 } })).rejects.toThrow();
    expect(fixture.read()).toBeUndefined();
  });
});
