import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEvents,
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import * as historyWorker from "../../config/sessions/session-history-worker-runtime.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { MAX_PAYLOAD_BYTES } from "../payload-limits.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import {
  expectHistoryError,
  expectHistoryMessage,
  historyPayload,
  historyRpc,
  withHistoryState,
  seedHistorySession,
  seedHistoryTranscript,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

async function seed(id: string, sessionStartedAt?: number) {
  await captureRuntimeConfigAsyncReader()();
  return seedHistorySession(id, sessionStartedAt === undefined ? {} : { sessionStartedAt });
}

async function replaceMessages(
  scope: Awaited<ReturnType<typeof seed>>,
  messages: Array<{ id: string } & Record<string, unknown>>,
) {
  await seedHistoryTranscript(
    scope,
    messages.map(({ id, ...message }): [string, Record<string, unknown>] => [id, message]),
  );
}

function expectNotFound(respond: Parameters<typeof historyPayload>[0]) {
  expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_found" });
}

it("uses indexed reads across hidden announce chunks while retaining recovered and partial replies", async () => {
  await withHistoryState(async () => {
    const scope = await seed("message-recovery", 2000);
    const failure = {
      role: "assistant",
      provider: "openai",
      model: "primary",
      content: [],
      stopReason: "error",
      errorMessage: "model unavailable",
      __openclaw: { runId: "run-recovery" },
    };
    const messages = [
      { id: "question", role: "user", timestamp: 1000, content: "Previous question" },
      { id: "previous-answer", role: "assistant", timestamp: 1000, content: "Previous answer" },
      { id: "user", role: "user", content: "hello" },
      { id: "failed", ...failure },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: `progress-${index}`,
        role: "toolResult",
        content: "Still working",
        toolCallId: `tool-${index}`,
      })),
      // The pair crosses the recovery reader's chunk boundary; neither row ends this turn.
      {
        id: "old-announce",
        role: "user",
        timestamp: 1000,
        content: "Old worker completion",
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
      {
        id: "old-pair",
        ...failure,
        timestamp: 1000,
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Old paired answer" }],
      },
    ];
    await replaceMessages(scope, messages);
    const context = await createHistoryReadContext();
    const request = historyRpc(context, scope.sessionKey);
    using read = vi.spyOn(historyWorker, "readSessionHistoryPageInWorker");
    const lookup = async (messageId: string) => {
      read.mockClear();
      const sql = observeHostDataSql();
      try {
        const respond = await request("chat.message.get", { messageId });
        expect(sql.queries).toEqual([]);
        expect(read.mock.calls.map(([input]) => input.kind)).toEqual(["message-by-id"]);
        return respond;
      } finally {
        sql.restore();
      }
    };
    expectNotFound(await lookup("failed"));
    expectNotFound(await lookup("old-announce"));
    expectNotFound(await lookup("old-pair"));
    for (const id of ["question", "previous-answer"]) {
      expectHistoryMessage(await lookup(id), { __openclaw: expect.objectContaining({ id }) });
    }

    await appendTranscriptMessage(scope, {
      eventId: "answer",
      message: {
        ...failure,
        model: "backup",
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Recovered answer" }],
      },
    });
    expectNotFound(await lookup("failed"));
    expectHistoryMessage(await lookup("answer"), {
      content: [{ type: "text", text: "Recovered answer" }],
    });

    await appendTranscriptMessage(scope, {
      eventId: "partial",
      message: { ...failure, content: [{ type: "text", text: "Partial answer" }] },
    });
    expectHistoryMessage(await lookup("partial"), {
      content: [{ type: "text", text: "Partial answer" }],
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "close-interval",
      parentId: "partial",
      reason: "new",
      timestamp: "2026-09-30T00:00:00.000Z",
    });
    expectNotFound(await lookup("old-pair"));
    expectHistoryMessage(await lookup("previous-answer"), {
      __openclaw: expect.objectContaining({ id: "previous-answer" }),
    });
  });
});

it("fetches a retained history reference without crossing conversation or pending-input ownership", async () => {
  await withHistoryState(async () => {
    const scope = await seed("retained-reference");
    const output = "Retained output\n" + "x".repeat(150_000);
    await appendTranscriptMessage(scope, {
      eventId: "retained-output",
      message: { role: "toolResult", toolCallId: "read-retained", content: output },
    });
    const pending = expectDefined(
      await stageSessionPendingInput(scope, {
        runId: "retained-pending",
        assertCurrent: () => {},
        message: {
          role: "user",
          content: "Retained pending input",
          timestamp: 1,
          idempotencyKey: "pending:user",
        },
      }),
      "pending input receipt",
    );
    pending.finish("cancelled");
    await pending.settled?.();
    const context = await createHistoryReadContext();
    const request = historyRpc(context, scope.sessionKey);
    await upsertSessionEntryCore(scope, { sessionId: "current-reference", updatedAt: 2 });
    await appendTranscriptMessage(
      { ...scope, sessionId: "current-reference" },
      {
        eventId: "retained-output",
        message: { role: "user", content: "Same ID in a different physical session" },
      },
    );
    expectHistoryMessage(
      await request("chat.message.get", {
        messageId: "retained-output",
        sessionId: scope.sessionId,
        maxChars: 200_000,
      }),
      { content: output },
    );
    expectNotFound(
      await request("chat.message.get", {
        messageId: `pending:${pending.inputId}`,
        sessionId: scope.sessionId,
      }),
    );

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:other-reference" },
      {
        sessionId: "other-reference",
        updatedAt: 1,
      },
    );
    expectHistoryError(
      await request("chat.message.get", {
        sessionKey: "agent:main:other-reference",
        sessionId: scope.sessionId,
        messageId: "retained-output",
      }),
      {
        code: "INVALID_REQUEST",
        message: "sessionId does not belong to sessionKey",
      },
    );
  });
});

it("reopens SQLite with bounded history previews and exact recoverable tool text", async () => {
  await withHistoryState(async () => {
    const scope = await seed("tool-output");
    const literal = " \n[[reply_to_current]]\r\n<untrusted>  \t";
    const output = literal + "line of output\n".repeat(12_000) + "\n😀 tail  \t\n";
    const largeOutput = literal + "x".repeat(1_050_000) + "\nEND  \n";
    const toolOutput = { source: "provider-response", modelInput: "unverified" };
    const tool = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
      id,
      text,
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: id.replace("-output", "-call"),
        content: [{ type: "text", text }],
        ...extra,
      },
    });
    const fixtures = [
      tool("provider-output", output, {
        __openclaw: { toolOutput, upstreamUserText: "PRIVATE_PROMPT" },
        isError: true,
        details: { private: "PRIVATE_DETAILS" },
        providerReplay: { private: "PRIVATE_REPLAY" },
      }),
      tool("execution-output", largeOutput, {
        toolName: "exec",
        isError: false,
        __openclaw: { toolOutput: { ...toolOutput, source: "execution" } },
      }),
      tool("legacy-output", literal + "legacy short result  \n"),
    ];
    for (const fixture of fixtures) {
      await appendTranscriptMessage(scope, { eventId: fixture.id, message: fixture.message });
    }
    const persisted = await loadTranscriptEvents(scope);
    const databasePath = resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    clearSessionStoreCacheForTest();
    expect(await loadTranscriptEvents(scope)).toEqual(persisted);

    const context = await createHistoryReadContext();
    const rpc = historyRpc(context, scope.sessionKey);
    const request = async (...args: Parameters<typeof rpc>) => historyPayload(await rpc(...args));
    const history = await request("chat.history");
    expect(Array.isArray(history.messages)).toBe(true);
    const messages = history.messages as Array<Record<string, unknown>>;
    for (const fixture of fixtures) {
      const preview = expectDefined(
        messages.find((message) => asOptionalRecord(message["__openclaw"])?.id === fixture.id),
        "tool history preview",
      );
      expect(preview).toMatchObject({
        role: "toolResult",
        toolCallId: fixture.message.toolCallId,
        toolName: fixture.message.toolName,
        content: [{ type: "text", text: fixture.text.slice(0, 8_000) }],
      });
      expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(128 * 1024);
      const metadata = asOptionalRecord(preview["__openclaw"]);
      expect(metadata?.truncated).toBe(fixture.text.length > 8_000 ? true : undefined);
      expect(metadata?.toolOutput).toEqual(
        asOptionalRecord(asOptionalRecord(fixture.message)?.["__openclaw"])?.toolOutput,
      );
      const response = await request("chat.message.get", {
        messageId: fixture.id,
        maxChars: 2_000_000,
      });
      expect(response).toMatchObject({
        ok: true,
        message: {
          toolCallId: fixture.message.toolCallId,
          content: [{ type: "text", text: fixture.text }],
        },
      });
      const full = expectDefined(asOptionalRecord(response.message), "full message");
      expect(asOptionalRecord(full["__openclaw"])?.truncated).toBeUndefined();
      for (const visible of [preview, full]) {
        for (const marker of ["PRIVATE_REPLAY", "PRIVATE_PROMPT", "PRIVATE_DETAILS"]) {
          expect(JSON.stringify(visible)).not.toContain(marker);
        }
      }
    }
    const capped = await request("chat.message.get", { messageId: "execution-output" });
    expect(capped).toMatchObject({
      ok: true,
      message: {
        content: [{ type: "text", text: largeOutput.slice(0, 1_000_000) }],
        __openclaw: {
          truncated: true,
          reason: "display-cap",
          toolOutput: { source: "execution", modelInput: "unverified" },
        },
      },
    });
    const smallCap = await request("chat.message.get", {
      messageId: "provider-output",
      maxChars: 32,
    });
    expect(smallCap).toMatchObject({
      ok: true,
      message: {
        isError: true,
        content: [{ type: "text", text: output.slice(0, 32) }],
        __openclaw: { truncated: true, reason: "display-cap", toolOutput },
      },
    });
    expect(await loadTranscriptEvents(scope)).toEqual(persisted);
  });
});

it("rejects a full structured message above the transport budget", async () => {
  await withHistoryState(async () => {
    const scope = await seed("tool-transport");
    // Every individual block fits maxChars, but their combined JSON does not.
    await appendTranscriptMessage(scope, {
      eventId: "large-result",
      message: {
        role: "toolResult",
        toolCallId: "large-call",
        toolName: "read",
        content: Array.from({ length: Math.ceil(MAX_PAYLOAD_BYTES / 2_000_000) }, () => ({
          type: "text",
          text: "x".repeat(2_000_000),
        })),
      },
    });
    const request = historyRpc(await createHistoryReadContext(), scope.sessionKey);
    const respond = await request("chat.message.get", {
      messageId: "large-result",
      maxChars: 2_000_000,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "oversized" });
  });
});

it.each([
  { agentId: "retired", sessionKey: "agent:retired:global", explicitOwnerAllowed: false },
  {
    agentId: "codex",
    sessionKey: "agent:codex:acp:11111111-1111-4111-8111-111111111111",
    explicitOwnerAllowed: false,
  },
  { agentId: "main", sessionKey: "agent:main:message-get-owner", explicitOwnerAllowed: true },
  {
    agentId: "main",
    sessionKey: "agent:main:acp:binding:slack:default:thread",
    explicitOwnerAllowed: true,
  },
])(
  "reads $sessionKey and validates explicit $agentId selection",
  async ({ agentId, sessionKey, explicitOwnerAllowed }) => {
    await withHistoryState(async (state) => {
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        session: { scope: "global" },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config, config);
      const scope = {
        agentId,
        sessionKey,
        sessionId: "retired-message-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        eventId: "retained-message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Retained retired-agent reply" }],
          stopReason: "stop",
        },
      });
      const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
      const rpc = historyRpc(context, scope.sessionKey);
      const request = { sessionKey: scope.sessionKey, messageId: "retained-message" };
      const readMessage = vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync");
      try {
        for (const explicitOwner of [false, true]) {
          readMessage.mockClear();
          const respond = await rpc("chat.message.get", {
            ...request,
            ...(explicitOwner ? { agentId } : {}),
          });
          expect(respond).toHaveBeenCalledOnce();
          if (explicitOwner && !explicitOwnerAllowed) {
            expectHistoryError(respond, {
              code: "INVALID_REQUEST",
              message: `Unknown agent id "${agentId}"`,
            });
            expect(readMessage).not.toHaveBeenCalled();
          } else {
            expectHistoryMessage(respond, {
              role: "assistant",
              content: [{ type: "text", text: "Retained retired-agent reply" }],
            });
            expect(readMessage).toHaveBeenCalledOnce();
          }
        }
      } finally {
        readMessage.mockRestore();
      }
    });
  },
);
