import { describe, expect, it, vi } from "vitest";
import * as protocol from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionEventSubscriberRegistry } from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createTranscriptUpdateBroadcastHandler } from "../server-session-events.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import { requestHistory } from "./chat-history-fixtures.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";

async function seed(sessionId: string, entry: Partial<SessionEntry>, text?: string) {
  const scope = { agentId: "main", sessionKey: key, sessionId };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1, ...entry });
  if (text) {
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: text, timestamp: 1 },
    });
  }
  return scope;
}

async function startup(
  context: GatewayRequestHandlerOptions["context"],
  client: GatewayRequestHandlerOptions["client"] = null,
  shortId = "12345678",
  limit?: number,
) {
  return requestHistory(
    "chat.startup",
    { shortId, agentId: "main", ...(limit === undefined ? {} : { limit }) },
    context,
    client,
  );
}

describe("chat.startup short references", () => {
  it("rejects malformed direct history before reading the session", async () => {
    const context = createDirectChatContext();
    const respond = await requestHistory("chat.history", { sessionKey: key, limit: 0 }, context);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each(["sessionKey", "shortId"] as const)(
    "validates %s input once before reading history",
    async (selector) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        await seed("validated-startup", {}, "Validated history");
        const context = createDirectChatContext();
        await initializeSessionReadContext(context);
        const params =
          selector === "sessionKey"
            ? { sessionKey: key }
            : { shortId: "12345678", agentId: "main" };
        const validation = vi.spyOn(protocol, "validateChatHistoryParams");
        try {
          const invalid = await requestHistory("chat.startup", { ...params, limit: 0 }, context);
          expect(invalid.mock.calls[0]?.[0]).toBe(false);
          const valid = await requestHistory("chat.startup", params, context);
          expect(valid.mock.calls[0]?.[1]).toMatchObject({
            messages: [expect.objectContaining({ content: "Validated history" })],
          });
          expect(validation).not.toHaveBeenCalled();
        } finally {
          validation.mockRestore();
        }
      });
    },
  );

  it.each([true, false])(
    "establishes observation before reading only for a live connection (%s)",
    async (live) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const scope = await seed(
          "observation-startup",
          { visibility: "shared" },
          "Snapshot history",
        );
        const client = {
          ...sharingPolicyClient({ scopes: ["operator.read"] }),
          connId: "short-startup-observer",
        };
        const subscribers = createSessionEventSubscriberRegistry(() => live);
        const broadcastToConnIds = vi.fn();
        const context = createDirectChatContext({
          subscribeSessionEvents: subscribers.subscribe,
          getSessionEventSubscriberConnIds: subscribers.getAll,
        });
        await initializeSessionReadContext(context);
        const emit = createTranscriptUpdateBroadcastHandler({
          getSessionRowProjection: () => getSessionRowProjection(context),
          broadcastToConnIds,
          sessionEventSubscribers: subscribers,
          sessionMessageSubscribers: { get: () => new Set() },
        });
        const lateMessage = { role: "assistant", content: "Arrived during startup", timestamp: 2 };
        const readChatStartupProjection = vi.fn(async () => {
          await appendTranscriptMessage(scope, { message: lateMessage });
          await emit({
            sessionKey: key,
            message: lateMessage,
            messageId: "late-message",
            messageSeq: 2,
          });
          return undefined;
        });
        context.readChatStartupProjection = readChatStartupProjection;
        const respond = await startup(context, client);
        if (live) {
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "session.message",
            expect.objectContaining({
              sessionKey: key,
              message: expect.objectContaining({ content: lateMessage.content }),
            }),
            new Set([client.connId]),
            {
              sessionEventSubscriptionKeys: [key],
              prepareSessionProjection: expect.any(Function),
            },
          );
          expect(broadcastToConnIds.mock.invocationCallOrder[0]).toBeLessThan(
            respond.mock.invocationCallOrder[0]!,
          );
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            messages: [expect.objectContaining({ content: "Snapshot history" })],
          });
        } else {
          expect(subscribers.getAll().size).toBe(0);
          expect(readChatStartupProjection).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          );
        }
      });
    },
  );
  it.each(["draft", "incognito", "foreign"] as const)(
    "does not disclose %s sessions through short references",
    async (visibility) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = rolePolicyConfig();
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const client = roleClient(visibility === "foreign" ? "none" : "view");
        await seed("hidden-short-startup", {
          visibility: visibility === "draft" ? "draft" : "shared",
          ...(visibility === "incognito" ? { incognito: true } : {}),
        });
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        await initializeSessionReadContext(context);
        expect(await startup(context, client)).toHaveBeenCalledExactlyOnceWith(true, {
          resolution: { ok: false },
        });
      });
    },
  );
  it("returns canonical history and bounded ambiguity through the existing resolver", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      await seed("short-startup", { displayName: "Selected conversation" }, "The selected history");
      const context = createDirectChatContext();
      await initializeSessionReadContext(context);
      const call = (shortId: string) => startup(context, null, shortId, 80);
      const phases: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>[] = [];
      const stop = onTrustedInternalDiagnosticEvent(
        (event) => {
          if (event.type === "diagnostic.phase.completed") {
            phases.push(event);
          }
        },
        { include: ["diagnostic.phase.completed"] },
      );
      let response;
      try {
        response = await call("12345678");
        await waitForDiagnosticEventsDrained();
      } finally {
        stop();
      }
      expect(phases.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "chat.startup.session_entry",
          "chat.startup.pending_inputs",
          "chat.startup.history_page",
          "chat.startup.startup_projection",
          "chat.startup.projection_final",
          "chat.startup.session_info",
        ]),
      );
      expect(phases.every(({ durationMs }) => durationMs !== undefined && durationMs >= 0)).toBe(
        true,
      );
      expect(phases.every(({ details }) => details === undefined)).toBe(true);
      expect(JSON.stringify(phases)).not.toContain(key);
      expect(response).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionKey: key,
          resolution: { ok: true, key, agentId: "main", displayName: "Selected conversation" },
          messages: expect.arrayContaining([
            expect.objectContaining({ content: "The selected history" }),
          ]),
        }),
        undefined,
        undefined,
      );
      expect(await call("aaaaaaaa")).toHaveBeenCalledWith(true, { resolution: { ok: false } });
      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey: "agent:main:dashboard:12345678-0bbb-4000-8000-000000000002",
        },
        { sessionId: "other", updatedAt: 2 },
      );
      expect(await call("12345678")).toHaveBeenCalledWith(true, {
        resolution: expect.objectContaining({
          ok: false,
          candidates: expect.arrayContaining([expect.objectContaining({ key })]),
        }),
      });
    });
  });
});
