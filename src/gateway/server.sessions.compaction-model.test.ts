import { expect, test } from "vitest";
import {
  seedSessionEntry,
  seedTranscriptRows,
} from "./server.sessions.compaction-fixtures.test-support.js";
import { embeddedRunMock, rpcReq } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";
// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("sessions.compact uses the model a child session inherits from its parent", async () => {
  const parentKey = "agent:main:dashboard:parent";
  const childKey = "agent:main:dashboard:child";
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    sessionKey: parentKey,
    storePath,
    entry: sessionStoreEntry("sess-parent", {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
    }),
  });
  await seedSessionEntry({
    sessionKey: childKey,
    storePath,
    entry: sessionStoreEntry("sess-child", {
      parentSessionKey: parentKey,
      authProfileOverride: "openai:personal",
      authProfileOverrideSource: "user",
    }),
  });
  await seedTranscriptRows({
    sessionId: "sess-child",
    sessionKey: childKey,
    storePath,
    totalLines: 3,
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
  });
  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: childKey });
    expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:personal",
      }),
      expect.anything(),
    );
  } finally {
    ws.close();
  }
});
