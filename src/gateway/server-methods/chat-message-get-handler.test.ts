import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import * as sessionUtils from "../session-utils.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

describe("chat.message.get recovery visibility", () => {
  it("hides recovered empty failures while retaining unresolved, partial, and successful replies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:message-recovery",
        sessionId: "message-recovery",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        eventId: "user",
        message: { role: "user", content: "hello" },
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
      await appendTranscriptMessage(scope, { eventId: "failed", message: failure });
      const respond = vi.fn();
      const context = createDirectChatContext();
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
      await lookup("failed");
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));

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

describe("durable tool output inspection", () => {
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
      expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
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
        context: createDirectChatContext(),
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
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const request = { sessionKey: scope.sessionKey, messageId: "retained-message" };
      const readEntry = vi.spyOn(sessionUtils, "loadGatewaySessionEntryReadOnly");
      const readMessage = vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync");
      try {
        for (const explicitOwner of [false, true]) {
          readEntry.mockClear();
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
            expect(readEntry).not.toHaveBeenCalled();
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
            expect(readEntry).toHaveBeenCalled();
            expect(readMessage).toHaveBeenCalledOnce();
          }
        }
      } finally {
        readEntry.mockRestore();
        readMessage.mockRestore();
      }
    });
  },
);
