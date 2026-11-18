/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";

it.for([false, true])(
  "started ACK projects only a known current execution model (already active: %s)",
  async (alreadyActive, { connect }) => {
    const key = "agent:main:execution-model-start";
    const runId = "new-model-run";
    const row = {
      key,
      status: alreadyActive ? "running" : "done",
      hasActiveRun: alreadyActive,
      activeRunIds: alreadyActive ? [runId] : [],
      activeModel: "previous-model",
      activeModelProvider: "fixture-provider",
    };
    const { request } = await connect({
      sessionKey: key,
      methodResponses: { "sessions.list": { sessions: [row] } },
    });
    await request("chat.send", { sessionKey: key, message: "Next turn", idempotencyKey: runId });
    const listed = await request("sessions.list");
    const history = await request("chat.history", { sessionKey: key });
    expect(listed.payload).toMatchObject({
      sessions: [{ key, status: "running", activeRunIds: [runId], hasActiveRun: true }],
    });
    for (const [payload, prefix] of [
      [listed.payload, "sessions.0"],
      [history.payload, "sessionInfo"],
    ] as const) {
      for (const field of ["activeModel", "activeModelProvider"] as const) {
        if (alreadyActive) {
          expect(payload).toHaveProperty(`${prefix}.${field}`, row[field]);
        } else {
          expect(payload).not.toHaveProperty(`${prefix}.${field}`);
        }
      }
    }
  },
);
