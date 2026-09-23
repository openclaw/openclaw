import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createRestartSafeChatRequest } from "./server-methods/chat-restart-recovery.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("chat.send recovers failed and statusless work for new messages and retained retries exactly once", async () => {
  const token = "orphaned-recovery-chat-token";
  const state = await createOpenClawTestState({
    label: "orphaned-recovery-chat",
    env: {
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const priorMessage = "Finish the interrupted recovery task.";
  const nextMessage = "Then verify the new request.";
  const targetRequests: string[] = [];
  let responseCount = 0;
  const providerServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes(priorMessage)) {
        targetRequests.push(body);
      }
      responseCount += 1;
      writeOpenAiResponsesText(response, {
        text: "RECOVERY_OK",
        messageId: `orphaned-recovery-${responseCount}`,
        responseId: `orphaned-recovery-response-${responseCount}`,
      });
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      throw new Error("recovery provider did not bind");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "gpt-orphaned-recovery",
    );
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          maxConcurrent: 1,
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
          },
        },
        entries: { main: { default: true } },
      },
      messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
      gateway: {
        auth: { mode: "token", token },
        controlUi: { allowedOrigins: ["http://localhost:18789"] },
      },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: "http://localhost:18789",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    await gateway.server.startupSettled;
    const client = gateway.client;
    for (const { status, retry } of [
      { status: "failed", retry: false },
      { status: undefined, retry: false },
      { status: "failed", retry: true },
      { status: undefined, retry: true },
    ] as const) {
      const caseId = `${status ?? "statusless"}-${retry ? "retry" : "new"}`;
      const sessionKey = `agent:main:dashboard:orphaned-chat-${caseId}`;
      const sessionId = `orphaned-chat-session-${caseId}`;
      const sourceRunId = `rejected-input-${caseId}`;
      targetRequests.length = 0;
      const target = {
        agentId: "main",
        sessionKey,
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await replaceSessionEntry(target, {
        sessionId,
        displayName: "Interrupted chat",
        updatedAt: Date.now(),
        status,
        ...(status === undefined ? {} : { abortedLastRun: false }),
        activeWriterRunId: "dead-writer",
        lastRunId: sourceRunId,
        mainRestartRecovery: { cycleId: "unfinished-cycle", revision: 7, chargedAttempts: 1 },
        restartRecoveryRuns: [
          { runId: "interrupted-run", lifecycleGeneration: "previous-gateway" },
          { runId: "interrupted-announcement", lifecycleGeneration: "older-gateway" },
        ],
        restartRecoveryDeliveryRunId: sourceRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoveryDeliveryRequestFingerprint: createRestartSafeChatRequest({
          cfg,
          eligible: true,
          message: priorMessage,
          senderIsOwner: true,
        })?.fingerprint,
        restartRecoverySourceIngress: "control-ui",
      });
      await appendTranscriptMessage(
        { ...target, sessionId },
        {
          cwd: state.workspaceDir,
          message: { role: "user", content: priorMessage, idempotencyKey: `${sourceRunId}:user` },
        },
      );
      const stranded = loadSessionEntry(target);
      if (retry) {
        await expect(
          client.request("chat.send", {
            sessionKey,
            sessionId,
            message: nextMessage,
            idempotencyKey: sourceRunId,
            deliver: false,
          }),
        ).rejects.toThrow(/different input/);
        expect(loadSessionEntry(target)).toEqual(stranded);
      }
      for (const [reason, stale] of [
        ["session", { sessionId: "replaced-session" }],
        ["branch", { expectedLeafEntryId: null }],
        ["permissions", { expectedPermissionMode: "guarded" }],
        ["tools", { expectedToolOverrides: { webSearch: false } }],
      ] as const) {
        await expect(
          client.request("chat.send", {
            sessionKey,
            sessionId,
            message: nextMessage,
            idempotencyKey: `stale-${caseId}-${reason}`,
            deliver: false,
            ...stale,
          }),
        ).rejects.toThrow(/changed/);
        expect(loadSessionEntry(target)).toEqual(stranded);
      }
      const runId = retry ? sourceRunId : `new-input-after-stranded-recovery-${caseId}`;
      await expect(
        client.request("chat.send", {
          sessionKey,
          sessionId,
          message: retry ? priorMessage : nextMessage,
          idempotencyKey: runId,
          deliver: false,
        }),
      ).resolves.toMatchObject({ runId, status: retry ? "ok" : "started" });
      if (!retry) {
        await vi.waitFor(
          async () => {
            const outcome = await client.request("agent.wait", { runId, timeoutMs: 30_000 });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "ok" });
          },
          { timeout: 30_000 },
        );
      }
      await vi.waitFor(
        () => {
          expect(loadSessionEntry(target)?.status).toBe("done");
        },
        { timeout: 30_000 },
      );
      expect(targetRequests).toHaveLength(retry ? 1 : 2);
      expect(targetRequests[0]).not.toContain(nextMessage);
      if (!retry) {
        expect(targetRequests[1]).toContain(nextMessage);
      }
      const recovered = loadSessionEntry(target);
      expect(recovered?.sessionId).toBe(sessionId);
      expect(recovered?.archivedAt).toBeUndefined();
      expect(recovered?.mainRestartRecovery).toBeUndefined();
      expect(recovered?.restartRecoveryRuns).toBeUndefined();
      const transcript = JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }));
      expect(transcript.split(priorMessage)).toHaveLength(2);
      expect(transcript.split(nextMessage)).toHaveLength(retry ? 1 : 2);
    }
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
    }
    if (providerServer.listening) {
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
    }
    await state.cleanup();
  }
}, 90_000);
