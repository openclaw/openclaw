import { expect, test } from "vitest";
import { createActiveRun } from "./server-methods/chat.abort.test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createConfiguredGlobalAgentSessionStore, resetConfiguredGlobalAgentSessionStore } =
  setupGatewaySessionsTestHarness();

test("sessions.compact does not attribute the default ownerless run to a selected agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({
    withTranscripts: true,
    writePrimeStore: true,
  });

  try {
    const compacted = await directSessionReq(
      "sessions.compact",
      { key: "global", agentId: "work", maxLines: 1 },
      {
        context: {
          chatAbortControllers: new Map([["run-main", createActiveRun("global")]]),
        },
      },
    );

    expect(compacted.ok).toBe(true);
  } finally {
    await resetConfiguredGlobalAgentSessionStore(globalStores);
  }
});
