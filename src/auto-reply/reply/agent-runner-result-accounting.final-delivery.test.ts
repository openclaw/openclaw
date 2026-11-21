import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { MessagingToolSourceReplyPayload } from "../../agents/embedded-agent-messaging.types.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { prepareEmbeddedRunTerminal } from "../../agents/embedded-agent-runner/run/terminal-preparation.js";
import { resolveEmbeddedRunTerminal } from "../../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { createUsageAccumulator } from "../../agents/embedded-agent-runner/usage-accumulator.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { persistInternalSourceReply } from "../../gateway/internal-source-reply-persistence.js";
import { createChatSendReplyDispatch } from "../../gateway/server-methods/chat-send-reply-dispatch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { createDeliverySuite } from "./agent-runner-delivery-suite.test-support.js";
import { agentAccountingPersistenceDiagnostic as diagnostic } from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { applyPreparedReplyMedia } from "./reply-media-paths.js";

const suite = createDeliverySuite();
const { createFixture } = suite;
const modelRef = { provider: diagnostic.provider, model: diagnostic.model };

async function prepareLocalReply(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  text: string,
  transcript: "assistant" | "missing" | "message-tool" = "assistant",
  restartNotice = false,
) {
  const { context, sessionId } = fixture;
  const { cfg, runId, sessionKey } = context;
  const { storePath } = suite;
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
    ...modelRef,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    assistantTexts: [text],
    lastAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    lastAssistantTextMessageIndex: 0,
    assistantTranscriptOwned: true,
  });
  if (restartNotice) {
    attempt.lastToolError = { toolName: "exec", error: "Command interrupted by restart" };
  }
  const terminal = makeTerminalInput({
    attempt,
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
  if (restartNotice) {
    terminal.terminalState = {
      outcome: { reason: "cancelled", status: "error", stopReason: "restart" },
      signalOwnedInterruption: true,
    };
  }
  const prepared = prepareEmbeddedRunTerminal({
    ...terminal,
    ...modelRef,
    currentAttemptCompletedAssistant: assistant,
    activeErrorContext: modelRef,
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: sessionId,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    resolvedToolResultFormat: "markdown",
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
  fixture.context.execution.result.payloads = [{ text: "durable final" }];
  const sql = observeHostDataSql();
  try {
    const result = await finalizeReplyAgentRun(fixture.context);
    expect(result).toMatchObject({ text: "durable final" });
    expect(sql.queries.join("\n")).not.toMatch(
      /\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/i,
    );
    const final = Array.isArray(result) ? result[0] : result;
    const completion = final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion;
    expect(completion).toMatchObject({
      sessionId: fixture.sessionId,
      sessionKey: fixture.context.sessionKey,
      storePath: suite.storePath,
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
  fixture.setMeta({ usage: { input: 120, output: 8 } });

  const result = await finalizeReplyAgentRun(context);

  expect(result).toMatchObject({ text: "Committed local answer." });
  const final = Array.isArray(result) ? result[0] : result;
  expect(final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion).toBeUndefined();
  await suite.reopen();
  expect(fixture.read()).toMatchObject({
    status: "done",
    endedAt: settledAt,
    updatedAt: settledAt,
    inputTokens: 120,
    outputTokens: 8,
  });
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
  expect(await sessionAccessor.loadTranscriptEvents(scope)).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ role: "assistant", content: "Committed local answer." }),
    }),
  );
});

it("does not create an ordinary final for a committed message-tool source mirror", async () => {
  const fixture = await createFixture();
  await prepareLocalReply(fixture, "Committed tool answer.", "message-tool");

  expect(fixture.context.execution.result.payloads).toBeUndefined();
  expect(await finalizeReplyAgentRun(fixture.context)).toBeUndefined();
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
});

async function prepareCommittedSourceReplies(media: boolean) {
  const fixture = await createFixture();
  const { context, sessionId } = fixture;
  const sessionKey = context.sessionKey!;
  const workspaceDir = context.followupRun.run.workspaceDir;
  context.cfg.agents = { entries: { main: { workspace: workspaceDir } } };
  const mediaPath = path.join(workspaceDir, "result.png");
  if (media) {
    fs.writeFileSync(
      mediaPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
        "base64",
      ),
    );
  }
  const replies: MessagingToolSourceReplyPayload[] = (
    [
      ["Working on the requested change.", false, "progress"],
      ["The requested change is complete.", true, "final"],
    ] as const
  ).map(([text, sourceReplyFinal, phase]) => {
    const reply: MessagingToolSourceReplyPayload = {
      text,
      sourceReplyFinal,
      transcriptOwner: true,
      idempotencyKey: `${context.runId}:message-tool:${phase}`,
    };
    if (media && sourceReplyFinal) {
      reply.mediaUrl = mediaPath;
    }
    return reply;
  });
  for (const reply of replies) {
    await persistInternalSourceReply({
      cfg: context.cfg,
      agentId: "main",
      sessionKey,
      expectedSessionId: sessionId,
      payload: reply,
      idempotencyKey: reply.idempotencyKey,
      runId: context.runId,
      // Automatic-mode source sends need not carry channel recovery authority.
      sourceReplyFinal: reply.sourceReplyFinal ? undefined : false,
    });
  }
  context.sessionCtx = { Provider: "webchat", Surface: "webchat" };
  context.execution.result.payloads = buildEmbeddedRunPayloads({
    assistantTexts: [],
    lastAssistant: undefined,
    isCronTrigger: false,
    sessionKey,
    agentId: "main",
    runId: context.runId,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "markdown",
    sourceReplyDeliveryState: "delivered",
    messagingToolSourceReplyPayloads: replies,
  });
  context.execution.result.sourceReplyDeliveryState = "delivered";
  const scope = { agentId: "main", storePath: suite.storePath, sessionKey, sessionId };
  const transcript = await sessionAccessor.loadTranscriptEvents(scope);

  return { fixture, scope, transcript };
}

it.each([false, true])(
  "does not leave restart delivery custody for committed source replies (media: %s)",
  async (media) => {
    const { fixture, scope, transcript } = await prepareCommittedSourceReplies(media);
    const result = await finalizeReplyAgentRun(fixture.context);

    expect(result).toHaveLength(2);
    expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
    await suite.reopen();
    expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
    expect(await sessionAccessor.loadTranscriptEvents(scope)).toEqual(transcript);
  },
);

it("retains custody for an MCP Connect presentation added after the source reply was committed", async () => {
  const { fixture, scope, transcript } = await prepareCommittedSourceReplies(false);
  const url = "https://auth.example/authorize?state=synthetic";
  fixture.context.execution.result.latestMcpConnectAction = {
    serverName: "calendar",
    authorizationUrl: url,
  };

  const result = await finalizeReplyAgentRun(fixture.context);

  expect(result).toHaveLength(2);
  const final = Array.isArray(result) ? result[1] : undefined;
  const button = { label: "Connect calendar", action: { type: "url", url } };
  expect(final?.presentation?.blocks).toEqual([{ type: "buttons", buttons: [button] }]);
  expect(
    final && getReplyPayloadMetadata(final)?.sourceReplyTranscriptMirror?.transcriptOwner,
  ).toBe(true);
  const pending = fixture.read()?.pendingFinalDelivery;
  expect(pending).toMatchObject({ kind: "transport-only", deliveries: [{ state: "prepared" }] });
  expect(pending?.deliveries).toHaveLength(1);
  await suite.reopen();
  expect(fixture.read()?.pendingFinalDelivery).toEqual(pending);
  expect(await sessionAccessor.loadTranscriptEvents(scope)).toEqual(transcript);
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
    fixture.setMeta({ usage: { input: 120, output: 8 } });
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
