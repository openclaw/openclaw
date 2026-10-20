// Preserve the real registry fixture's module setup before importing handlers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  captureSessionTarget,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { registerChatAbortController } from "../chat-abort.js";
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
    const controllerTarget = captureSessionTarget({
      storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: target.agentId,
      }),
      ...target,
      incarnation: sessionId,
    });
    let execution: Promise<void> | undefined;
    if (backend === "embedded") {
      registerTestEmbeddedRun(
        sessionId,
        handle,
        sessionKey,
        undefined,
        "main",
        undefined,
        undefined,
        {
          target: controllerTarget,
        },
      );
    } else {
      const registration = registerChatAbortController({
        target: controllerTarget,
        runId: "stuck-backend",
        ...target,
        sessionId,
        timeoutMs: 60_000,
        sourceWork: completion.promise,
        onCancel: onAbort,
      });
      if (!registration.registered) {
        throw new Error("Expected the unresponsive controller source to register");
      }
      const claim = await claimSessionControllerTask(registration.entry.input, (selected) => {
        createReplyOperation({
          ...target,
          sessionId,
          resetTriggered: false,
          target: controllerTarget,
          mailboxClaim: selected,
        });
      });
      execution = completion.promise.finally(() => {
        claim.operation?.complete();
        releaseSessionControllerClaim(claim);
        registration.cleanup();
      });
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
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
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
      clearTestEmbeddedRun(sessionId, handle, sessionKey);
      await execution;
      await request;
    }
  },
);
