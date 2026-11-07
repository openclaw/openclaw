import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { prepareChatSessionAbort } from "./chat-abort-session-plan.js";
import { createChatAbortContext, invokeChatAbortHandler } from "./chat.abort.test-helpers.js";

it.each(["alice", "bob"])(
  "retained maintenance custody authorizes current %s without an active RPC",
  async (profileId) => {
    const sessionKey = "agent:main:maintenance-auth-" + randomUUID(),
      sessionId = randomUUID();
    const target = captureSessionTarget({
      storeScope: "/synthetic/maintenance/sessions.json",
      sessionKey,
      incarnation: sessionId,
      agentId: "main",
    });
    const original = new AbortController();
    const initiator = createAdmittedRunOperatorAuthority({
      profileId: "alice",
      scopes: ["operator.write"],
      signal: original.signal,
      assertCurrent: () => original.signal.throwIfAborted(),
    });
    let release = () => {};
    const interrupted = vi.fn(() => release());
    const effect = await beginSessionEffect({
      target,
      run: {
        runId: randomUUID(),
        sessionKey,
        sessionId,
        agentId: "main",
        abortAuthority: {
          initiatingPersonalOperator: initiator,
          requester: { deviceId: "shared-device", connectionId: "old-connection" },
        },
      },
      onInterrupt: interrupted,
    });
    release = () => effect.release();
    original.abort();
    try {
      await invokeChatAbortHandler({
        context: createChatAbortContext(),
        request: { sessionKey },
        handler: async ({ context }) => {
          const plan = prepareChatSessionAbort(
            {
              context,
              ops: createChatAbortOps(context),
              sessionKey,
              sessionId,
              agentId: "main",
              controllerTargets: [target],
              abortOrigin: "rpc",
              stopSource: "client-session",
              hookContext: { sessionKey, sessionId, commandSource: "rpc" },
              requester: {
                isAdmin: false,
                connId: "new-connection",
                deviceId: profileId === "alice" ? "new-device" : "shared-device",
                personalAuthority: {
                  profileId,
                  target: { sessionKey, sessionId, agentId: "main" },
                  assertCurrent: () => {},
                },
              },
            },
            undefined,
          );
          plan.abort();
          await plan.finish();
        },
      });
      expect(interrupted).toHaveBeenCalledTimes(profileId === "alice" ? 1 : 0);
    } finally {
      effect.release();
    }
  },
);
