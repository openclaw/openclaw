// Preserve the real registry fixture's module setup before importing handlers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as runs from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as sessionStore from "../../config/sessions/session-accessor.js";
import * as lifecycle from "../../sessions/session-controller.lifecycle.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient } from "../session-sharing.test-utils.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

useChatAbortRegistryFixture();

it.each(["sessions.delete", "sessions.patch"] as const)(
  "%s reports its finite drain timeout with an unresponsive embedded backend",
  async (method) => {
    const sessionKey = "agent:main:drain-timeout";
    const sessionId = "drain-timeout-session";
    const target = { agentId: "main", sessionKey };
    await sessionStore.upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const aborted = createDeferred();
    const onAbort = () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      aborted.resolve();
    };
    const handle = runs.createEmbeddedRunHandle({ abort: onAbort });
    runs.registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
    const respond = vi.fn();
    const client = roleClient("write", "timeout-operator");
    client.connect.scopes = ["operator.admin"];
    const request = handleGatewayRequest({
      req: gatewayRequest("drain-timeout", method, {
        key: sessionKey,
        ...(method === "sessions.patch" ? { archived: true, expectedSessionId: sessionId } : {}),
      }),
      client,
      context: createDirectChatContext({ getRuntimeConfig }),
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { ...sessionDeleteHandlers, ...sessionMutationHandlers },
    });
    try {
      await awaitGateBeforeSettlement(aborted.promise, request, "backend was not cancelled");
      await vi.advanceTimersByTimeAsync(lifecycle.SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      ]);
      const entry = sessionStore.loadSessionEntry(target);
      expect([entry?.sessionId, entry?.archivedAt]).toEqual([sessionId, undefined]);
    } finally {
      vi.useRealTimers();
      runs.clearTestEmbeddedRun(sessionId, handle, sessionKey);
      await request;
    }
  },
);
