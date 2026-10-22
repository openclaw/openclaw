import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { resolveSessionEntryResetFreshnessAsync } from "../config/sessions/entry-freshness.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { areHeartbeatsEnabled, setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const replyText = "Daily rollover reply is ready.";
const sessionKey = "agent:main:dashboard:rollover-proof";
type Completion = { status: string; error?: string; terminalReply?: { text?: string } };
type Client = Awaited<ReturnType<typeof startGatewayWithClient>>["client"];
const nativeClient = { clientName: "openclaw-macos", mode: "ui" } as const;

it.each([false, true])(
  "answers chat.send after a dashboard daily rollover (native reconnect: %s)",
  verifyDashboardRollover,
  120_000,
);

async function verifyDashboardRollover(nativeReconnect: boolean) {
  resetGatewayTestState();
  const home = await setupGatewayTempHome({ prefix: "openclaw-dashboard-title-rollover-" });
  const heartbeatsEnabled = areHeartbeatsEnabled();
  const provider = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      JSON.parse(await readRequestText(request));
      writeOpenAiResponsesText(response, {
        text: replyText,
        messageId: `msg-${randomUUID()}`,
        responseId: `resp-${randomUUID()}`,
      });
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    setHeartbeatsEnabled(false);
    const providerUrl = await listenLoopback(provider);
    const model = buildMockOpenAiResponsesProvider(`${providerUrl}/v1`, "rollover-proof");
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
      gateway: {
        auth: { mode: "token", token: "rollover-proof" },
        controlUi: { allowedOrigins: ["http://localhost"] },
      },
    } satisfies OpenClawConfig;
    const connection = {
      token: "rollover-proof",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    };
    gateway = await startGatewayWithClient({
      cfg,
      configPath: await createGatewayConfigPath(home.tempHome),
      ...connection,
      ...(nativeReconnect ? nativeClient : {}),
    });
    const url = `ws://127.0.0.1:${gateway.port}`;
    const connect = (
      client: Pick<Parameters<typeof connectGatewayClient>[0], "clientName" | "mode" | "origin">,
    ) => connectGatewayClient({ url, ...connection, ...client });
    if (nativeReconnect) {
      await disconnectGatewayClient(gateway.client);
      gateway.client = await connect(nativeClient);
    }
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
    const freshness = await resolveSessionEntryResetFreshnessAsync({
      agentId: "main",
      now: Date.now(),
      resetType: "direct",
      sessionCfg: cfg.session,
      sessionKey,
      storePath: scope.storePath,
    });
    expect(freshness).toMatchObject({ state: "stale", freshness: { staleReason: "daily" } });
    if (nativeReconnect) {
      const resumed = await sendAndWait(gateway.client, "Resume the matching displayed session.", {
        sessionId: seededSessionId,
        __controlUiReconnectResume: true,
      });
      const retained = loadSessionEntry(scope);
      expect(resumed.status, resumed.error).toBe("ok");
      expect(resumed.terminalReply?.text).toBe(replyText);
      expect(retained).toMatchObject({
        sessionId: seededSessionId,
        lifecycleRevision: "seed-revision",
        sessionStartedAt: staleAt,
      });
      const publicClient = await connect({
        clientName: "webchat-ui",
        origin: "http://localhost",
        mode: "webchat",
      });
      try {
        await expect(
          publicClient.request("chat.send", {
            sessionKey,
            sessionId: seededSessionId,
            message: "Reject public reconnect metadata.",
            __controlUiReconnectResume: true,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toThrow("unexpected property '__controlUiReconnectResume'");
        expect(loadSessionEntry(scope)?.lifecycleRevision).toBe("seed-revision");
      } finally {
        await disconnectGatewayClient(publicClient);
      }
    }
    const result = await sendAndWait(gateway.client, "Continue after the daily reset.", {
      sessionId: seededSessionId,
    });
    const rolled = loadSessionEntry(scope);
    expect(result.status, result.error).toBe("ok");
    expect(result.terminalReply?.text).toBe(replyText);
    expect(rolled?.sessionId).toBe(seededSessionId);
    expect(rolled?.sessionStartedAt).toBeGreaterThan(staleAt + 24 * 60 * 60 * 1000);
    expect(rolled?.lifecycleRevision).not.toBe("seed-revision");
    expect(result.error ?? result.terminalReply?.text ?? "").not.toContain(
      "timed out draining work",
    );
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
    await closeHttpServer(provider);
    setHeartbeatsEnabled(heartbeatsEnabled);
    home.envSnapshot.restore();
    await removeGatewayTempHome(home.tempHome);
    resetGatewayTestState();
  }
}

async function sendAndWait(
  client: Client,
  message: string,
  reconnect: { sessionId?: string; __controlUiReconnectResume?: boolean } = {},
): Promise<Completion> {
  const { runId } = await client.request<{ runId: string }>("chat.send", {
    sessionKey,
    message,
    ...reconnect,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  return await client.request<Completion>(
    "agent.wait",
    { runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
}
