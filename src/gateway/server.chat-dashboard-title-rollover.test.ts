import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { resolveSessionEntryResetFreshness } from "../config/sessions/entry-freshness.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const replyText = "Daily rollover reply is ready.";
const sessionKey = "agent:main:dashboard:rollover-proof";

it("answers chat.send after a dashboard daily rollover", async () => {
  resetGatewayTestState();
  const home = await setupGatewayTempHome({ prefix: "openclaw-dashboard-title-rollover-" });
  const provider = createServer((request, response) => {
    void readAndComplete(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const transcript: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("mock provider did not bind");
    }
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "rollover-proof",
    );
    const cfg = {
      session: { reset: { mode: "daily", atHour: 4 } },
      agents: {
        defaults: {
          workspace: home.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      tools: { profile: "minimal" },
      gateway: { auth: { mode: "token", token: "rollover-proof" } },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: await createGatewayConfigPath(home.tempHome),
      token: "rollover-proof",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const scope = {
      agentId: "main",
      sessionKey,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    const seededSessionId = "stale-dashboard-session";
    const staleAt = Date.now() - 48 * 60 * 60 * 1000;
    await replaceSessionEntry(scope, {
      sessionId: seededSessionId,
      lifecycleRevision: "seed-revision",
      sessionStartedAt: staleAt,
      updatedAt: staleAt,
      lastInteractionAt: staleAt,
    });
    clearSessionStoreCacheForTest();
    const freshness = resolveSessionEntryResetFreshness({
      agentId: "main",
      now: Date.now(),
      resetType: "direct",
      sessionCfg: cfg.session,
      sessionKey,
      storePath: scope.storePath,
    });
    const staleReason = freshness.state === "stale" ? freshness.freshness.staleReason : undefined;
    const result = await sendAndWait(gateway, "Continue after the daily reset.");
    const rolled = loadSessionEntry(scope);
    const drainTimeout = (result.error ?? result.terminalReply?.text ?? "").includes(
      "timed out draining work",
    );
    transcript.push(
      `chat.send sessionKey=${sessionKey}`,
      `seeded sessionId=${seededSessionId} freshness=${freshness.state} staleReason=${staleReason ?? "none"}`,
      "sessionStartedAt is 48h before the daily boundary atHour=4",
      `status=${result.status} error=${JSON.stringify(result.error ?? "")} sessionId=${rolled?.sessionId ?? "missing"} reply=${JSON.stringify(result.terminalReply?.text ?? "")}`,
      `sessionStartedAtRefreshed=${(rolled?.sessionStartedAt ?? 0) > staleAt + 24 * 60 * 60 * 1000}`,
      `lifecycleRotated=${rolled?.lifecycleRevision !== "seed-revision"}`,
      `drainTimeout=${drainTimeout}`,
    );
    console.info(transcript.join("\n"));
    expect(freshness.state).toBe("stale");
    expect(staleReason).toBe("daily");
    expect(result.status, result.error).toBe("ok");
    expect(result.terminalReply?.text).toBe(replyText);
    expect(rolled?.sessionId).toBe(seededSessionId);
    expect(rolled?.sessionStartedAt).toBeGreaterThan(staleAt + 24 * 60 * 60 * 1000);
    expect(rolled?.lifecycleRevision).not.toBe("seed-revision");
    expect(drainTimeout).toBe(false);
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
    provider.closeAllConnections();
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
    });
    home.envSnapshot.restore();
    await removeGatewayTempHome(home.tempHome);
    resetGatewayTestState();
  }
}, 120_000);

async function readAndComplete(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  JSON.parse(Buffer.concat(chunks).toString("utf8"));
  writeOpenAiResponsesText(response, {
    text: replyText,
    messageId: `msg-${randomUUID()}`,
    responseId: `resp-${randomUUID()}`,
  });
}

async function sendAndWait(
  gateway: Awaited<ReturnType<typeof startGatewayWithClient>>,
  message: string,
): Promise<{ status: string; error?: string; terminalReply?: { text?: string } }> {
  const started = await gateway.client.request<{ runId: string }>("chat.send", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  return await gateway.client.request<{
    status: string;
    error?: string;
    terminalReply?: { text?: string };
  }>("agent.wait", { runId: started.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
}
