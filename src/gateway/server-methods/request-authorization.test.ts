import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { sendAuthorizationRequest } from "../server-methods.authorization.test-support.js";
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

it("dispatches an admitted agent-only send while another agent is preparing", async () => {
  recordAgentDatabaseAdmissions(
    [
      createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [],
        reason: "Synthetic inspection is pending.",
        pending: true,
      }),
    ],
    { source: "startup" },
  );
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { sent: true }));
  const respond = await sendAuthorizationRequest(
    "send",
    {
      agentId: "work",
      to: "channel:C1",
      channel: "slack",
      message: "hello",
      idempotencyKey: "healthy-agent-send",
    },
    {
      scopes: ["operator.admin"],
      context: {
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        agentDatabaseStartup: {
          hasPendingAgents: true,
          waitForAgentPreparation: () => {
            throw new Error("An admitted send must not wait for startup preparation");
          },
        },
      },
      extraHandlers: { send: handler },
    },
  );
  expect(respond).toHaveBeenCalledWith(true, { sent: true });
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "refuses an agent-only send before dispatch while inspection is pending=%s",
  async (pending) => {
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "work",
      paths: [],
      reason: pending ? "Synthetic inspection is pending." : "Synthetic inspection failed.",
      pending,
    });
    recordAgentDatabaseAdmissions([refusal], { source: "startup" });
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { sent: true }));
    const startup = {
      hasPendingAgents: pending,
      waitForAgentPreparation: () => {
        throw new Error("Writes must refuse without waiting for startup preparation");
      },
    };
    const send = () =>
      sendAuthorizationRequest(
        "send",
        {
          agentId: "work",
          channel: "slack",
          to: "channel:C1",
          message: "hello",
          idempotencyKey: "agent-only-startup",
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
      );

    const respond = await send();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: pending,
        ...(pending
          ? { details: { reason: "startup-sidecars", method: "send" } }
          : { details: refusal }),
      }),
    );

    recordAgentDatabaseAdmissions([], { source: "startup" });
    startup.hasPendingAgents = false;
    expect(await send()).toHaveBeenCalledWith(true, { sent: true });
    expect(handler).toHaveBeenCalledTimes(1);
  },
);
