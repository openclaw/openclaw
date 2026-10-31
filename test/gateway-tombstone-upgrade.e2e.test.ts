import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  appendTranscriptMessageSync,
} from "../src/config/sessions/session-accessor.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { openOpenClawAgentDatabase } from "../src/state/openclaw-agent-db.js";
import { ensureGatewayOwnerProfile } from "../src/state/user-profiles.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";
import { restartResumeConfig } from "./gateway-restart-resume.test-support.js";
import { connectRestartClient, restartEnv } from "./gateway-restart.test-support.js";
import { startOpenAiResponsesModelServer } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it("upgrades a tombstoned root, resumes it, and completes a fresh Gateway chat turn", async ({
  signal,
}) => {
  let ordinal = 0;
  const provider = await startOpenAiResponsesModelServer({
    modelId: "synthetic-model",
    bindError: "Synthetic provider failed to bind",
    onRequest: async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      const id = String(++ordinal);
      writeOpenAiResponsesText(response, {
        text: body.includes("FRESH_AFTER_UPGRADE") ? "FRESH_OK" : "RESUME_OK",
        messageId: `msg_${id}`,
        responseId: `resp_${id}`,
      });
    },
  });
  const model = buildMockOpenAiResponsesProvider(`${provider.baseUrl}/v1`, "synthetic-model");
  const config = restartResumeConfig(model);
  const instance = await createOpenClawTestInstance({
    name: "tombstone-upgrade",
    signal,
    config: { ...config, agents: { ...config.agents, entries: { legacy: {} } } },
    env: restartEnv,
  });
  let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
  await runQaGatewayFixture(
    async () => {
      const scope = { agentId: "legacy", sessionKey: "agent:legacy:main", env: instance.env };
      const sessionId = randomUUID();
      const owner = ensureGatewayOwnerProfile(null, { env: instance.env });
      replaceSessionEntrySync(scope, {
        sessionId,
        updatedAt: 42,
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      expect(
        appendTranscriptMessageSync(
          { ...scope, sessionId },
          { message: { role: "user", content: "Keep this original transcript" } },
        ).ok,
      ).toBe(true);
      const database = openOpenClawAgentDatabase(scope);
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.mainRestartRecovery', json(?), '$.pendingFinalDelivery', json(?), '$.restartRecoveryRuns', json(?)) WHERE session_key = ?",
        )
        .run(
          JSON.stringify({
            cycleId: "old",
            foregroundClaims: {
              lifecycleGeneration: "old-generation",
              tokens: [],
              runIdsByClaimId: {},
            },
            tombstone: { reason: "delegated recovery sender authority is unavailable" },
          }),
          JSON.stringify({
            kind: "replayable",
            text: "Unsent legacy final",
            createdAt: 42,
            sourceRunId: "old-0",
          }),
          JSON.stringify(
            Array.from({ length: 8 }, (_, i) => ({
              runId: `old-${i}`,
              lifecycleGeneration: "old-generation",
            })),
          ),
          scope.sessionKey,
        );
      await cleanupSessionStateForTest();
      await instance.startGateway();
      client = await connectRestartClient(instance, {}, signal);
      const history = () =>
        client!.request<{ messages: unknown[]; sessionInfo: { hasActiveRun: boolean } }>(
          "chat.history",
          { sessionKey: scope.sessionKey, limit: 100 },
        );
      const waitFinal = (text: string) =>
        withinTest(
          vi.waitFor(
            async () => {
              const result = await history();
              expect(JSON.stringify(result.messages), instance.logs()).toContain(text);
              expect(result.sessionInfo.hasActiveRun).toBe(false);
              return result;
            },
            { timeout: 30_000 },
          ),
          signal,
        );
      await waitFinal("RESUME_OK");
      expect(
        await client.request(
          "chat.send",
          {
            sessionKey: scope.sessionKey,
            message: "FRESH_AFTER_UPGRADE",
            idempotencyKey: randomUUID(),
          },
          { expectFinal: false },
        ),
      ).toMatchObject({ runId: expect.any(String) });
      const result = await waitFinal("FRESH_OK");
      expect(JSON.stringify(result.messages)).toContain("Keep this original transcript");
      process.stdout.write(
        "[tombstone-upgrade-proof] real Gateway + agent + synthetic HTTP model: startup resume completed; fresh chat.send completed; original transcript preserved\n",
      );
    },
    () => client?.stopAndWait(),
    () => instance.cleanup(),
    () => provider.close(),
  );
});
