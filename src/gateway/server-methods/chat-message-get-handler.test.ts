import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
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
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as historyWorker from "../../config/sessions/session-history-worker-runtime.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { MAX_PAYLOAD_BYTES } from "../payload-limits.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

describe("chat.message.get recovery visibility", () => {
  it("hides recovered failures across hidden announce chunks while retaining unresolved and partial replies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:message-recovery",
        sessionId: "message-recovery",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        sessionStartedAt: 2000,
      });
      const failure = {
        role: "assistant",
        provider: "openai",
        model: "primary",
        content: [],
        stopReason: "error",
        errorMessage: "model unavailable",
        __openclaw: { runId: "run-recovery" },
      };
      const messages: Array<[string, Record<string, unknown>]> = [
        ["user", { role: "user", content: "hello" }],
        ["failed", failure],
        ...Array.from({ length: 99 }, (_, index): [string, Record<string, unknown>] => [
          `progress-${index}`,
          { role: "toolResult", content: "Still working", toolCallId: `tool-${index}` },
        ]),
        // The pair crosses the recovery reader's chunk boundary; neither row ends this turn.
        [
          "old-announce",
          {
            role: "user",
            timestamp: 1000,
            content: "Old worker completion",
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          },
        ],
        [
          "old-pair",
          {
            ...failure,
            timestamp: 1000,
            stopReason: "stop",
            errorMessage: undefined,
            content: [{ type: "text", text: "Old paired answer" }],
          },
        ],
      ];
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...messages.map(([id, message], index) => ({
          type: "message",
          id,
          parentId: messages[index - 1]?.[0] ?? null,
          message,
        })),
      ]);
      const respond = vi.fn();
      const context = await createHistoryReadContext();
      const lookup = async (messageId: string) => {
        respond.mockClear();
        await expectDefined(
          chatMessageGetHandlers["chat.message.get"],
          "message handler",
        )({
          params: { sessionKey: scope.sessionKey, messageId },
          context,
          req: { type: "req", id: "message-recovery", method: "chat.message.get" },
          client: null,
          isWebchatConnect: () => false,
          respond,
        });
      };
      const readHistory = async (params: Record<string, unknown>) => {
        const historyRespond = vi.fn();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey: scope.sessionKey, ...params },
          context,
          req: { type: "req", id: "page-recovery", method: "chat.history" },
          client: null,
          isWebchatConnect: () => false,
          respond: historyRespond,
        });
        expect(historyRespond.mock.calls[0]?.[0]).toBe(true);
        return asOptionalRecord(historyRespond.mock.calls[0]?.[1])?.messages;
      };
      const failedMessage = expect.objectContaining({
        __openclaw: expect.objectContaining({ id: "failed" }),
      });
      await lookup("failed");
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
      // The initial page ends on the hidden announce; its paired reply is newer lookahead.
      expect(await readHistory({ offset: 1, limit: messages.length - 1 })).toContainEqual(
        failedMessage,
      );

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
      const persisted = await loadTranscriptEvents(scope);
      await lookup("failed");
      expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_found" });
      for (const params of [{ messageId: "failed" }, { offset: messages.length - 1 }]) {
        expect(await readHistory({ limit: 1, ...params })).toEqual(
          "messageId" in params
            ? []
            : [expect.objectContaining({ __openclaw: expect.objectContaining({ id: "user" }) })],
        );
      }
      // Both hidden rows now fit the initial window; only the real retry repairs the failure.
      expect(await readHistory({ offset: 1, limit: messages.length })).not.toContainEqual(
        failedMessage,
      );
      await lookup("answer");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          message: expect.objectContaining({
            content: [{ type: "text", text: "Recovered answer" }],
          }),
        }),
      );
      expect(await loadTranscriptEvents(scope)).toEqual(persisted);

      await appendTranscriptMessage(scope, {
        eventId: "partial",
        message: { ...failure, content: [{ type: "text", text: "Partial answer" }] },
      });
      await lookup("partial");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          message: expect.objectContaining({ content: [{ type: "text", text: "Partial answer" }] }),
        }),
      );
    });
  });
});

it("resolves one indexed message per worker request while hiding stale announce pairs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:indexed-message-get",
      sessionId: "indexed-message-get",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      sessionStartedAt: 2000,
    });
    const messages = [
      { id: "question", role: "user", timestamp: 1000, content: "Previous question" },
      { id: "answer", role: "assistant", timestamp: 1000, content: "Previous answer" },
      {
        id: "announce",
        role: "user",
        timestamp: 1000,
        content: "Worker finished",
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
      { id: "stale-answer", role: "assistant", timestamp: 1000, content: "Hidden pair" },
      { id: "current-answer", role: "assistant", timestamp: 3000, content: "Current answer" },
    ];
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...messages.map(({ id, ...message }, index) => ({
        type: "message",
        id,
        parentId: messages[index - 1]?.id ?? null,
        message,
      })),
    ]);
    const context = await createHistoryReadContext();
    const read = vi.spyOn(historyWorker, "readSessionHistoryPageInWorker");
    try {
      const lookup = async (messageId: string) => {
        read.mockClear();
        const respond = vi.fn<RespondFn>();
        const sql = observeHostDataSql();
        try {
          await expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId },
            context,
            client: null,
            req: { type: "req", id: "indexed-message-get", method: "chat.message.get" },
            isWebchatConnect: () => false,
            respond,
          });
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        expect(read.mock.calls.map(([request]) => request.kind)).toEqual(["message-by-id"]);
        if (messageId === "announce" || messageId === "stale-answer") {
          expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_found" });
        } else {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              ok: true,
              message: expect.objectContaining({
                __openclaw: expect.objectContaining({ id: messageId }),
              }),
            }),
          );
        }
      };
      for (const messageId of [
        "question",
        "answer",
        "announce",
        "stale-answer",
        "current-answer",
      ]) {
        await lookup(messageId);
      }
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "close-interval",
        parentId: "current-answer",
        reason: "new",
        timestamp: "2026-09-30T00:00:00.000Z",
      });
      await lookup("stale-answer");
      await lookup("answer");
    } finally {
      read.mockRestore();
    }
  });
});

describe("durable tool output inspection", () => {
  it("fetches a retained history reference without crossing conversation or pending-input ownership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:retained-reference",
        sessionId: "retained-reference",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
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
      const request = async (
        method: "chat.history" | "chat.message.get",
        params: Record<string, unknown>,
      ) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          (method === "chat.history" ? chatHistoryHandlers : chatMessageGetHandlers)[method],
          "history handler",
        )({
          params: { sessionKey: scope.sessionKey, ...params },
          context,
          req: { type: "req", id: "retained-reference", method },
          client: null,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledTimes(1);
        return respond;
      };
      const preview = await request("chat.history", {
        messageId: "retained-output",
        maxChars: 200_000,
      });
      expect(preview).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionId: scope.sessionId,
          messages: [
            expect.objectContaining({
              __openclaw: expect.objectContaining({ id: "retained-output", truncated: true }),
            }),
          ],
        }),
      );
      await upsertSessionEntryCore(scope, { sessionId: "current-reference", updatedAt: 2 });
      await appendTranscriptMessage(
        { ...scope, sessionId: "current-reference" },
        {
          eventId: "retained-output",
          message: { role: "user", content: "Same ID in a different physical session" },
        },
      );
      expect(
        await request("chat.message.get", {
          messageId: "retained-output",
          sessionId: scope.sessionId,
          maxChars: 200_000,
        }),
      ).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          message: expect.objectContaining({ content: output }),
        }),
      );
      expect(
        await request("chat.message.get", {
          messageId: `pending:${pending.inputId}`,
          sessionId: scope.sessionId,
        }),
      ).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_found" });

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:other-reference" },
        {
          sessionId: "other-reference",
          updatedAt: 1,
        },
      );
      expect(
        await request("chat.message.get", {
          sessionKey: "agent:main:other-reference",
          sessionId: scope.sessionId,
          messageId: "retained-output",
        }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "sessionId does not belong to sessionKey",
        }),
      );
    });
  });

  it("reopens SQLite with bounded history previews and exact recoverable tool text", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:tool-output",
        sessionId: "tool-output",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const literal = " \n[[reply_to_current]]\r\n<untrusted>  \t";
      const output = literal + "line of output\n".repeat(12_000) + "\n😀 tail  \t\n";
      const largeOutput = literal + "x".repeat(1_050_000) + "\nEND  \n";
      const toolOutput = { source: "provider-response", modelInput: "unverified" };
      const fixtures = [
        {
          id: "provider-output",
          text: output,
          message: {
            role: "toolResult",
            toolName: "read",
            toolCallId: "provider-call",
            isError: true,
            content: [{ type: "text", text: output }],
            details: { private: "PRIVATE_DETAILS" },
            providerReplay: { private: "PRIVATE_REPLAY" },
            __openclaw: { toolOutput, upstreamUserText: "PRIVATE_PROMPT" },
          },
        },
        {
          id: "execution-output",
          text: largeOutput,
          message: {
            role: "toolResult",
            toolName: "exec",
            toolCallId: "execution-call",
            isError: false,
            content: [{ type: "text", text: largeOutput }],
            __openclaw: { toolOutput: { ...toolOutput, source: "execution" } },
          },
        },
        {
          id: "legacy-output",
          text: literal + "legacy short result  \n",
          message: {
            role: "toolResult",
            toolName: "read",
            toolCallId: "legacy-call",
            content: [{ type: "text", text: literal + "legacy short result  \n" }],
          },
        },
      ];
      for (const fixture of fixtures) {
        await appendTranscriptMessage(scope, { eventId: fixture.id, message: fixture.message });
      }
      const persisted = await loadTranscriptEvents(scope);
      const databasePath = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      const claimSoleCustody = () => {
        const database = new DatabaseSync(databasePath);
        try {
          // A retained WAL connection prevents exclusive custody even between reads.
          database.exec(
            "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT",
          );
        } finally {
          database.close();
        }
      };
      expect(claimSoleCustody).toThrow(/database is locked/);
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      expect(claimSoleCustody).not.toThrow();
      clearSessionStoreCacheForTest();
      expect(await loadTranscriptEvents(scope)).toEqual(persisted);
      for (const fixture of fixtures) {
        expect(persisted).toContainEqual(expect.objectContaining({ message: fixture.message }));
      }

      const context = await createHistoryReadContext();
      const handlers: GatewayRequestHandlers = {
        ...chatHistoryHandlers,
        ...chatMessageGetHandlers,
      };
      const request = async (method: string, params: Record<string, unknown> = {}) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          handlers[method],
          "history handler",
        )({
          params: { sessionKey: scope.sessionKey, ...params },
          context,
          req: { type: "req", id: "tool-output", method },
          client: null,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledTimes(1);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        return expectDefined(asOptionalRecord(respond.mock.calls[0]?.[1]), "RPC result");
      };
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
        expect(metadata?.toolOutput).toEqual(fixture.message["__openclaw"]?.toolOutput);
        for (const marker of ["PRIVATE_REPLAY", "PRIVATE_PROMPT", "PRIVATE_DETAILS"]) {
          expect(JSON.stringify(preview)).not.toContain(marker);
        }
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
        for (const marker of ["PRIVATE_REPLAY", "PRIVATE_PROMPT", "PRIVATE_DETAILS"]) {
          expect(JSON.stringify(full)).not.toContain(marker);
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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:tool-transport",
        sessionId: "tool-transport",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
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
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        chatMessageGetHandlers["chat.message.get"],
        "message handler",
      )({
        params: { sessionKey: scope.sessionKey, messageId: "large-result", maxChars: 2_000_000 },
        context: await createHistoryReadContext(),
        client: null,
        req: { type: "req", id: "tool-transport", method: "chat.message.get" },
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "oversized" });
    });
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      const request = { sessionKey: scope.sessionKey, messageId: "retained-message" };
      const readMessage = vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync");
      try {
        for (const explicitOwner of [false, true]) {
          readMessage.mockClear();
          const respond = vi.fn();
          await expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { ...request, ...(explicitOwner ? { agentId } : {}) },
            context,
            req: { type: "req", id: "retired-message", method: "chat.message.get" },
            client: null,
            isWebchatConnect: () => false,
            respond,
          });
          expect(respond).toHaveBeenCalledOnce();
          if (explicitOwner && !explicitOwnerAllowed) {
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                code: "INVALID_REQUEST",
                message: `Unknown agent id "${agentId}"`,
              }),
            );
            expect(readMessage).not.toHaveBeenCalled();
          } else {
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                ok: true,
                message: expect.objectContaining({
                  role: "assistant",
                  content: [{ type: "text", text: "Retained retired-agent reply" }],
                }),
              }),
            );
            expect(readMessage).toHaveBeenCalledOnce();
          }
        }
      } finally {
        readMessage.mockRestore();
      }
    });
  },
);
