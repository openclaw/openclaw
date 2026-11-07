import path from "node:path";
import { expect, it } from "vitest";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { recordGatewaySessionRunFailure } from "../src/sessions/session-run-error.js";
import { formatProviderRefusalText } from "../src/shared/assistant-error-format.js";
import { readRunFailureNotice } from "../src/shared/run-failure-notice.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

// The user-visible regression lives past the recorder: an older transcript keeps only the
// error code, the failure is recorded, and only then does the published history show it.
// All three steps run against a Gateway started as its own process.
const SESSION_KEY = "agent:main:legacy-misalignment";
const SESSION_ID = "legacy-misalignment";
const RUN_ID = "legacy-misalignment-run";
const LEGACY_NOTICE = "The provider stopped this request as a safety precaution (misalignment).";

it(
  "keeps the legacy safety-precaution explanation in the chat-history notice",
  { timeout: 180_000 },
  async () => {
    const instance = await createOpenClawTestInstance({ name: "legacy-refusal-notice" });
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    await runQaGatewayFixture(
      async () => {
        const scope = {
          agentId: "main",
          sessionKey: SESSION_KEY,
          sessionId: SESSION_ID,
          storePath: path.join(instance.state.sessionsDir("main"), "sessions.json"),
        };
        // Seed the pre-Gateway state: the transcript retains only the error code, so the
        // shipped producer renders the legacy explanation without refusal diagnostics.
        await replaceSessionEntry(scope, { sessionId: SESSION_ID, updatedAt: 1 });
        const error = formatProviderRefusalText({ errorCode: "misalignment_policy_violation" });
        expect(error).toBe(LEGACY_NOTICE);
        await recordGatewaySessionRunFailure({ target: scope, runId: RUN_ID, error });

        await instance.startGateway();
        client = await connectProofClient(instance);
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
        });
        expect((history.messages ?? []).map(readRunFailureNotice).filter(Boolean)).toEqual([
          { runId: RUN_ID, summary: `Your request couldn't be completed: ${LEGACY_NOTICE}` },
        ]);
      },
      () => client && disconnectGatewayClient(client),
      () => instance.cleanup(),
    );
  },
);
