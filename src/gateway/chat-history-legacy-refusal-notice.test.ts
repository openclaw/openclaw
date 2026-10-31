import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { recordGatewaySessionRunFailure } from "../sessions/session-run-error.js";
import { formatProviderRefusalText } from "../shared/assistant-error-format.js";
import { readRunFailureNotice } from "../shared/run-failure-notice.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

const SESSION_KEY = "agent:main:legacy-misalignment";
const SESSION_ID = "legacy-misalignment";
const RUN_ID = "legacy-misalignment-run";
const LEGACY_NOTICE = "The provider stopped this request as a safety precaution (misalignment).";

it("keeps the legacy safety-precaution explanation in the chat-history notice", async () => {
  // openclaw-temp-dir: allow the running Gateway keeps this store open past the test
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-legacy-refusal-")),
  );
  const storePath = path.join(dir, "openclaw-agent.sqlite");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: { [SESSION_KEY]: { sessionId: SESSION_ID, updatedAt: 1 } },
  });

  // An older transcript retains only the error code, so the shipped producer renders the
  // legacy explanation and no provider_refusal diagnostic carries it instead.
  const error = formatProviderRefusalText({ errorCode: "misalignment_policy_violation" });
  expect(error).toBe(LEGACY_NOTICE);

  await recordGatewaySessionRunFailure({
    target: { agentId: "main", sessionKey: SESSION_KEY, sessionId: SESSION_ID, storePath },
    runId: RUN_ID,
    error,
  });

  // Read the failure notice the way a Control UI pane does: through the Gateway itself.
  const response = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", {
    sessionKey: SESSION_KEY,
  });
  expect(response.ok).toBe(true);
  expect((response.payload?.messages ?? []).map(readRunFailureNotice).filter(Boolean)).toEqual([
    { runId: RUN_ID, summary: `Your request couldn't be completed: ${LEGACY_NOTICE}` },
  ]);
});
