import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { recoverTerminalSessionEntryForVisibleTurn } from "../config/sessions/terminal-status.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
} from "./gateway-provider-fixture.test-support.js";
import { createRestartSafeChatRequest } from "./server-methods/chat-restart-recovery.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("preserves interrupted recovery custody when reusing a failed session", () => {
  const entry = {
    sessionId: "interrupted-session",
    updatedAt: 1,
    status: "failed" as const,
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "unfinished-cycle", revision: 7, chargedAttempts: 1 },
    restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "previous-gateway" }],
    restartRecoveryDeliveryRunId: "interrupted-run",
    restartRecoveryDeliverySourceRunId: "accepted-input",
  };

  expect(recoverTerminalSessionEntryForVisibleTurn(entry)).toEqual(entry);
});

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
      const body = await readProviderBody(request);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
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
  const runProof = async () => {
    const provider = buildMockOpenAiResponsesProvider(
      await listenProvider(providerServer),
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
        entries: { main: {} },
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
      const send = (
        idempotencyKey: string,
        message: string,
        overrides: Record<string, unknown> = {},
      ) =>
        client.request("chat.send", {
          sessionKey,
          sessionId,
          message,
          idempotencyKey,
          deliver: false,
          ...overrides,
        });
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
        restartRecoveryDeliveryRequestFingerprint: (
          await createRestartSafeChatRequest({
            cfg,
            eligible: true,
            message: priorMessage,
            senderIsOwner: true,
          })
        )?.fingerprint,
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
        await expect(send(sourceRunId, nextMessage)).rejects.toThrow(/different input/);
        expect(loadSessionEntry(target)).toEqual(stranded);
      }
      for (const [reason, stale] of [
        ["session", { sessionId: "replaced-session" }],
        ["permissions", { expectedPermissionMode: "guarded" }],
        ["tools", { expectedToolOverrides: { webSearch: false } }],
      ] as const) {
        await expect(send(`stale-${caseId}-${reason}`, nextMessage, stale)).rejects.toThrow(
          /changed/,
        );
        expect(loadSessionEntry(target)).toEqual(stranded);
      }
      const runId = retry ? sourceRunId : `new-input-after-stranded-recovery-${caseId}`;
      await expect(send(runId, retry ? priorMessage : nextMessage)).resolves.toMatchObject({
        runId,
        status: retry ? "ok" : "started",
      });
      await vi.waitFor(
        async () => {
          if (!retry) {
            const outcome = await client.request("agent.wait", { runId, timeoutMs: 30_000 });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "ok" });
          }
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
      // Captured model-prompt metadata can repeat text without creating another user turn.
      const transcript = JSON.stringify(
        (await loadTranscriptEvents({ ...target, sessionId })).flatMap((event) =>
          isRecord(event) && event.type === "message" && isRecord(event.message)
            ? [event.message.content]
            : [],
        ),
      );
      expect(transcript.split(priorMessage)).toHaveLength(2);
      expect(transcript.split(nextMessage)).toHaveLength(retry ? 1 : 2);
    }
  };
  await runQaGatewayFixture(
    runProof,
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close(),
    () => providerServer.listening && closeProvider(providerServer),
    () => state.cleanup(),
  );
}, 90_000);
