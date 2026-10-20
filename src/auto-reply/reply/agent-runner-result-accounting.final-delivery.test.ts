import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareEmbeddedRunTerminal } from "../../agents/embedded-agent-runner/run/terminal-preparation.js";
import { resolveEmbeddedRunTerminal } from "../../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { createUsageAccumulator } from "../../agents/embedded-agent-runner/usage-accumulator.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { createChatSendReplyDispatch } from "../../gateway/server-methods/chat-send-reply-dispatch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { applyPreparedReplyMedia } from "./reply-media-paths.js";

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

async function prepareLocalReply(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text: string,
  transcript: "assistant" | "missing" | "message-tool" = "assistant",
  restartNotice = false,
) {
  const { context, sessionId } = fixture;
  const { cfg, runId, sessionKey } = context;
  if (!sessionKey) {
    throw new Error("Expected a session-bound reply fixture");
  }
  const scope = { agentId: "main", storePath, sessionKey, sessionId };
  const userTurnRecorder = createUserTurnTranscriptRecorder({
    input: { text: "Reply to this synthetic input.", idempotencyKey: `${runId}:user` },
    target: { ...scope, sessionEntry: context.activeSessionEntry },
  });
  await userTurnRecorder.persistApproved();
  const dispatch = createChatSendReplyDispatch({
    getRuntimeConfig: () => cfg,
    accountId: undefined,
    isAgentRunStarted: () => true,
    isRunCurrent: () => true,
    logGateway: createSubsystemLogger("test/accounting-local-reply"),
    session: {
      ...scope,
      entry: context.activeSessionEntry,
      backingSessionId: sessionId,
      cfg,
      clientRunId: runId,
      sessionLoadOptions: { agentId: "main" },
    },
    userTurnRecorder,
  });
  dispatch.captureAgentTranscriptStart(runId, null);
  if (transcript !== "missing") {
    const message = attachSessionTranscriptRunId(
      {
        role: "assistant",
        content: text,
        ...(transcript === "message-tool"
          ? { openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true } }
          : {}),
      },
      runId,
    );
    const appended = await sessionAccessor.appendTranscriptMessage(scope, {
      eventId: `${runId}:final`,
      message,
    });
    if (!appended.messageId) {
      throw new Error("Expected a committed local assistant reply");
    }
    await sessionAccessor.publishTranscriptUpdate(scope, {
      message,
      messageId: appended.messageId,
    });
  }
  const facts = await dispatch.resolveReplyDeliveryFacts();
  expect(facts).toEqual({
    source: transcript === "message-tool" ? "delivered" : "missing",
    terminal: transcript === "missing" ? "missing" : "delivered",
  });
  const assistant = buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text }],
    provider: diagnostic.provider,
    model: diagnostic.model,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    assistantTexts: [text],
    lastAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    lastAssistantTextMessageIndex: 0,
    assistantTranscriptOwned: true,
    ...(restartNotice
      ? { lastToolError: { toolName: "exec", error: "Command interrupted by restart" } }
      : {}),
  });
  const terminal = makeTerminalInput({
    attempt,
    ...(restartNotice
      ? {
          terminalState: {
            outcome: { reason: "cancelled", status: "error", stopReason: "restart" },
            signalOwnedInterruption: true,
          },
        }
      : {}),
    runParams: {
      sessionId,
      sessionKey,
      runId,
      config: cfg,
      agentDir: context.followupRun.run.agentDir,
      workspaceDir: context.followupRun.run.workspaceDir,
      authProfileStateMode: "read-only",
    },
  });
  const prepared = prepareEmbeddedRunTerminal({
    runParams: terminal.runParams,
    attempt,
    currentAttemptCompletedAssistant: assistant,
    provider: diagnostic.provider,
    model: diagnostic.model,
    activeErrorContext: { provider: diagnostic.provider, model: diagnostic.model },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: sessionId,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: terminal.contextRecoveryState,
    resolvedToolResultFormat: "markdown",
    terminalState: terminal.terminalState,
    replyDeliveryState: facts.terminal,
    sourceReplyDeliveryState: facts.source,
  });
  const resolved = await resolveEmbeddedRunTerminal({ ...terminal, prepared });
  if (resolved.action !== "complete") {
    throw new Error("Expected a completed synthetic model turn");
  }
  context.sessionCtx = { Provider: "webchat", Surface: "webchat" };
  context.opts = { resolveReplyDelivery: dispatch.resolveReplyDelivery };
  context.execution.result = resolved.result;
  // Source delivery remains distinct from committed local transcript delivery.
  expect(resolved.result.sourceReplyDeliveryState).toBe(facts.source);
  return scope;
}

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

it("keeps a committed local answer in history without a second final delivery intent", async () => {
  const fixture = await createFixture();
  const scope = await prepareLocalReply(fixture, "Committed local answer.");
  const { context } = fixture;
  expect(
    getReplyPayloadMetadata(context.execution.result.payloads![0]!)
      ?.localTranscriptDeliveryConfirmed,
  ).toBe(true);
  const settledAt = 1_000;
  const settled = {
    ...fixture.read()!,
    status: "done" as const,
    endedAt: settledAt,
    updatedAt: settledAt,
    lastRunId: context.runId,
  };
  await fixture.replace(settled);
  context.activeSessionEntry = settled;
  context.activeSessionStore![scope.sessionKey] = settled;
  context.execution.result.meta.agentMeta = {
    sessionId: fixture.sessionId,
    provider: diagnostic.provider,
    model: diagnostic.model,
    usage: { input: 120, output: 8 },
  };

  const result = await finalizeReplyAgentRun(context);

  expect(result).toMatchObject({ text: "Committed local answer." });
  const final = Array.isArray(result) ? result[0] : result;
  expect(final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion).toBeUndefined();
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  expect(fixture.read()).toMatchObject({
    status: "done",
    endedAt: settledAt,
    updatedAt: settledAt,
    inputTokens: 120,
    outputTokens: 8,
  });
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
  expect(await sessionAccessor.loadTranscriptEvents(scope)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({ role: "assistant", content: "Committed local answer." }),
      }),
    ]),
  );
});

it("does not create an ordinary final for a committed message-tool source mirror", async () => {
  const fixture = await createFixture();
  await prepareLocalReply(fixture, "Committed tool answer.", "message-tool");

  expect(fixture.context.execution.result.payloads).toBeUndefined();
  expect(await finalizeReplyAgentRun(fixture.context)).toBeUndefined();
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
});

it.each([
  "external route",
  "explicit delivery route",
  "unconfirmed transcript",
  "media",
  "failed media warning",
  "generated text",
  "usage footer",
  "reminder note",
] as const)("retains final custody for %s", async (reason) => {
  const fixture = await createFixture();
  const { context } = fixture;
  const text =
    reason === "reminder note" ? "Final answer. I'll remind you tomorrow." : "Final answer.";
  await prepareLocalReply(
    fixture,
    text,
    reason === "unconfirmed transcript" ? "missing" : "assistant",
    reason === "generated text",
  );
  const payload = context.execution.result.payloads![0]!;
  if (reason === "media" || reason === "failed media warning") {
    payload.mediaUrl = "https://example.invalid/final.png";
    if (reason === "failed media warning") {
      context.replyMediaContext.normalizePayload = async (value) =>
        applyPreparedReplyMedia(value, [
          {
            source: "https://example.invalid/final.png",
            outcome: { failure: { code: "file-not-found", kind: "image", label: "final.png" } },
          },
        ]);
    }
  }
  if (reason === "external route") {
    context.sessionCtx = {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:synthetic",
    };
  } else if (reason === "explicit delivery route") {
    context.sessionCtx.ExplicitDeliverRoute = true;
  } else if (reason === "usage footer") {
    context.cfg.messages = { responseUsage: "tokens" };
    context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
  }

  const result = await finalizeReplyAgentRun(context);

  const final = Array.isArray(result) ? result[0] : result;
  expect(final?.text).toContain(
    reason === "generated text" ? "Gateway restarting" : "Final answer.",
  );
  if (reason === "failed media warning") {
    expect(final?.mediaUrl).toBeUndefined();
    expect(final?.text).toContain("File not found");
  }
  expect(final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion).toBeDefined();
  expect(fixture.read()?.pendingFinalDelivery).toMatchObject({
    deliveries: [{ state: "prepared" }],
  });
});
