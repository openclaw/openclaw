import { expect, test } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createConfiguredGlobalAgentSessionStore, resetConfiguredGlobalAgentSessionStore } =
  setupGatewaySessionsTestHarness();

test("sessions.delete protects a retained legacy default global session", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  try {
    const deleted = await directSessionReq("sessions.delete", {
      key: "global",
      agentId: "main",
      deleteTranscript: false,
    });

    expect(deleted).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Cannot delete the main session (global)." },
    });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: "global",
        storePath: globalStores.mainStorePath,
      })?.sessionId,
    ).toBe("sess-main-global");
  } finally {
    await resetConfiguredGlobalAgentSessionStore(globalStores);
  }
});

test("sessions.delete falls back from a departed retained owner to the current sole agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  try {
    const cfg = globalStores.getRuntimeConfig();
    cfg.agents = { entries: { research: {} } };
    retainLegacyDefaultAgentId(cfg, "ops");

    const deleted = await directSessionReq("sessions.delete", {
      key: "global",
      agentId: "research",
      deleteTranscript: false,
    });

    expect(deleted).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Cannot delete the main session (global)." },
    });
  } finally {
    await resetConfiguredGlobalAgentSessionStore(globalStores);
  }
});
