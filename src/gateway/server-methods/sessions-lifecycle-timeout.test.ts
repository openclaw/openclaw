// Preserve the real registry fixture's module setup before importing handlers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import {
  removeChatAbortControllerEntry,
  runWithChatAbortExecution,
} from "../chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient } from "../session-sharing.test-utils.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

useChatAbortRegistryFixture();

it.each([
  { method: "sessions.delete", backend: "embedded" },
  { method: "sessions.patch", backend: "embedded" },
  { method: "sessions.delete", backend: "controller" },
  { method: "sessions.patch", backend: "controller" },
] as const)(
  "$method reports its finite drain timeout with an unresponsive $backend backend",
  async ({ method, backend }) => {
    const sessionKey = "agent:main:drain-timeout";
    const sessionId = "drain-timeout-session";
    const target = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const context = createDirectChatContext({ getRuntimeConfig });
    const aborted = createDeferred();
    const completion = createDeferred();
    const onAbort = () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      aborted.resolve();
    };
    const handle = createEmbeddedRunHandle({ abort: onAbort });
    let execution: Promise<void> | undefined;
    if (backend === "embedded") {
      setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
    } else {
      const entry: ChatAbortControllerEntry = {
        agentId: "main",
        sessionKey,
        sessionId,
        controller: new AbortController(),
        startedAtMs: 1,
        expiresAtMs: Infinity,
      };
      entry.controller.signal.addEventListener("abort", onAbort, { once: true });
      context.chatAbortControllers.set("stuck-backend", entry);
      execution = runWithChatAbortExecution(
        entry,
        () => completion.promise,
        () => {},
      );
    }
    const respond = vi.fn();
    const client = roleClient("write", "timeout-operator");
    client.connect.scopes = ["operator.admin"];
    const request = handleGatewayRequest({
      req: {
        type: "req",
        id: "drain-timeout",
        method,
        params: {
          key: sessionKey,
          ...(method === "sessions.patch" ? { archived: true, expectedSessionId: sessionId } : {}),
        },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { ...sessionDeleteHandlers, ...sessionMutationHandlers },
    });
    try {
      await awaitGateBeforeSettlement(aborted.promise, request, "backend was not cancelled");
      await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringMatching(
            method === "sessions.patch"
              ? /did not finish stopping; retry the archive/
              : /still active after the lifecycle drain/,
          ),
          retryable: true,
        }),
      ]);
      expect(loadSessionEntry(target)).toMatchObject({ sessionId });
      expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
      completion.resolve();
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      await execution;
      removeChatAbortControllerEntry(context.chatAbortControllers, "stuck-backend");
      await request;
    }
  },
);
