import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { sendAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { expectRpcError } from "./rpc-response.test-support.js";
import type { GatewayRequestHandler } from "./types.js";

const tempDirs = createTempDirTracker();

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("send-startup-authorization-"));
});

afterEach(() => {
  recordAgentDatabaseAdmissions([], { source: "startup" });
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function createSend(agentId: string, pending: boolean, idempotencyKey = "agent-only-startup") {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId,
    paths: [],
    pending,
    reason: pending ? "Synthetic inspection is pending." : "Synthetic inspection failed.",
  });
  recordAgentDatabaseAdmissions([refusal], { source: "startup" });
  const startup = {
    hasPendingAgents: pending,
    isAgentInputRecoveryPending: () => false,
    waitForAgentPreparation: () => {
      throw new Error("Send must not wait for startup preparation");
    },
  };
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { sent: true }));
  return {
    handler,
    startup,
    refusal,
    send: () =>
      sendAuthorizationRequest(
        "send",
        {
          agentId: "work",
          to: "channel:C1",
          channel: "slack",
          message: "hello",
          idempotencyKey,
        },
        {
          scopes: ["operator.admin"],
          context: {
            getRuntimeConfig: () => ({
              agents: { ownership: "explicit", entries: { main: {}, work: {} } },
            }),
            agentDatabaseStartup: startup,
          },
          extraHandlers: { send: handler },
        },
      ),
  };
}

it("dispatches an admitted agent-only send while another agent is preparing", async () => {
  const { handler, send } = createSend("main", true, "healthy-agent-send");
  const respond = await send();
  expect(respond).toHaveBeenCalledWith(true, { sent: true });
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "refuses an agent-only send before dispatch while inspection is pending=%s",
  async (pending) => {
    const { handler, send, startup, refusal } = createSend("work", pending);

    const respond = await send();
    expect(handler).not.toHaveBeenCalled();
    expectRpcError(respond, {
      code: "UNAVAILABLE",
      retryable: pending,
      ...(pending
        ? { details: { reason: "startup-sidecars", method: "send" } }
        : { details: refusal }),
    });

    recordAgentDatabaseAdmissions([], { source: "startup" });
    startup.hasPendingAgents = false;
    expect(await send()).toHaveBeenCalledWith(true, { sent: true });
    expect(handler).toHaveBeenCalledTimes(1);
  },
);
