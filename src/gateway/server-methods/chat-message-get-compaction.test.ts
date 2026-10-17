import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

it("reads a compaction summary by ID without expanding history or bypassing text limits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:compaction-inspection",
      sessionId: "compaction-inspection",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      eventId: "prompt",
      message: { role: "user", content: "Remember the deployment plan." },
    });
    const summary = "## Deployment plan\n\n" + "Keep the staged rollout.\n".repeat(500);
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compacted",
      parentId: "prompt",
      timestamp: "2026-10-15T12:00:00.000Z",
      firstKeptEntryId: "prompt",
      summary,
      tokensBefore: 100,
      tokensAfter: 25,
      details: { privateDiagnostic: "NOT_CLIENT_CONTENT" },
    });
    const context = await createHistoryReadContext();
    const handlers: GatewayRequestHandlers = { ...chatHistoryHandlers, ...chatMessageGetHandlers };
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        handlers[method],
        "history handler",
      )({
        params: { sessionKey: scope.sessionKey, ...params },
        context,
        req: { type: "req", id: "compaction-inspection", method },
        client: null,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return expectDefined(asOptionalRecord(respond.mock.calls[0]?.[1]), "RPC result");
    };
    const history = await request("chat.history");
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: [{ type: "text", text: "Compaction" }],
          __openclaw: expect.objectContaining({ kind: "compaction", id: "compacted" }),
        }),
      ]),
    );
    const full = await request("chat.message.get", { messageId: "compacted" });
    expect(full).toMatchObject({
      ok: true,
      message: {
        role: "system",
        content: [{ type: "text", text: summary }],
        __openclaw: { kind: "compaction", id: "compacted", tokensBefore: 100, tokensAfter: 25 },
      },
    });
    expect(JSON.stringify(full)).not.toContain("NOT_CLIENT_CONTENT");
    expect(
      await request("chat.message.get", { messageId: "compacted", maxChars: 32 }),
    ).toMatchObject({
      ok: true,
      message: {
        content: [{ type: "text", text: summary.slice(0, 32) + "\n...(truncated)..." }],
        __openclaw: { truncated: true, reason: "display-cap" },
      },
    });
    expect(await request("chat.message.get", { messageId: "absent" })).toEqual({
      ok: false,
      unavailableReason: "not_found",
    });
    const other = { agentId: "main", sessionKey: "agent:main:other", sessionId: "other" };
    await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
    expect(
      await request("chat.message.get", {
        sessionKey: other.sessionKey,
        messageId: "compacted",
      }),
    ).toEqual({ ok: false, unavailableReason: "not_found" });
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 2,
      cliSessionBindings: { "claude-cli": { sessionId: "synthetic-cli-session" } },
    });
    expect(await request("chat.message.get", { messageId: "compacted" })).toMatchObject({
      ok: true,
      message: { content: [{ type: "text", text: summary }] },
    });
  });
});
