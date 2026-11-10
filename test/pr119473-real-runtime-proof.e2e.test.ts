import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../src/config/config.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);
const TOKEN = "pr119473-proof-token";

it(
  "persists the first turn of a fresh SQLite-backed session across gateway restart",
  { timeout: 90_000 },
  async () => {
    const fixture = await createFixture("openclaw-pr119473-proof-", TOKEN);
    let providerServer: ReturnType<typeof createServer> | undefined;
    let first: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let second: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

    try {
      providerServer = createServer((_request, response) => {
        writeOpenAiResponsesText(response, {
          messageId: "pr119473-proof-message",
          responseId: "pr119473-proof-response",
          text: "PR119473_RUNTIME_OK",
        });
      });
      const baseUrl = await listenProofProvider(providerServer);
      const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`);
      const cfg = fixture.config(provider, {
        models: {
          [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
        },
      });
      const sessionKey = "agent:main:pr119473-fresh-runtime";
      const marker = "PR119473_FIRST_USER_MESSAGE";
      const start = (clientDisplayName: string) =>
        startGatewayWithClient({
          cfg,
          configPath: fixture.configPath,
          token: TOKEN,
          clientDisplayName,
        });
      first = await start("pr119473-proof-first-start");
      const started = await first.client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey,
        message: marker,
        deliver: false,
        idempotencyKey: "pr119473-proof-first-turn",
      });
      expect(started).toMatchObject({ status: "started", runId: expect.any(String) });
      await expect(
        first.client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).resolves.toMatchObject({ status: "ok" });
      await disconnectGatewayClient(first.client);
      await first.server.close({ reason: "PR #119473 proof restart" });
      first = undefined;

      clearRuntimeConfigSnapshot();
      second = await start("pr119473-proof-after-restart");
      const history = await second.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      expect(JSON.stringify(history.messages ?? [])).toContain(marker);
    } finally {
      await fixture.close(second ?? first, providerServer);
    }
  },
);
