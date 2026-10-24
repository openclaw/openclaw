import { afterEach, expect, test } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  await closeOpenClawStateDatabaseAsync();
});

// Memory audience resolution reads the root's durable chat type; a root created
// without a message and later driven by sessions_send or cron must not lack it.
test("records an operator-created root as a direct chat before any turn runs", async () => {
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{ key: string }>("sessions.create", { agentId: "main" });
  expect(created.ok).toBe(true);
  const key = created.payload!.key;
  expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: key })).toMatchObject({
    createdVia: "operator",
    chatType: "direct",
  });
});
