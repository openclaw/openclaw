/**
 * PR #165724 real gateway proof: realtime Talk forced consult adopts its recorded
 * question when the checking acknowledgment speech finalizes during consult startup.
 *
 * Boots a real gateway server (SQLite session store, embedded agent runner, trusted
 * chat-send consult path) with:
 * - a loopback OpenAI-Responses mock as the backing agent provider, and
 * - a loopback realtime voice provider whose bridge reproduces the released-version
 *   failure sequence from #165683: final user transcript -> forced consult input
 *   persisted -> checking acknowledgment speech appended to the shared transcript
 *   while the consult run is preparing its replay admission.
 */
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { loadTranscriptEventsSync } from "../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { prepareTalkSessionTarget } from "../src/gateway/talk/session-target.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import type { RealtimeVoiceProviderPlugin } from "../src/plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/state/openclaw-agent-db.js";
import { ensureClientVoiceAgentSessionEntry } from "../src/talk/client-voice-session.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../src/talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { createDeferred } from "./helpers/promise.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const TOKEN = "pr165724-proof-token";
const VOICE_PROVIDER_ID = "pr165724-voice";
const SESSION_KEY = "agent:main:pr165724-talk-proof";
const QUESTION = "Hallo, wie geht es dir?";
const CHECKING_SPEECH = "Ich prüfe das kurz mit OpenClaw.";
const ANSWER = "Mir geht es gut, danke der Nachfrage. PR165724_CONSULT_ANSWER_OK";

const epoch = performance.now();
function proof(event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      proof: true,
      pr: 165724,
      event,
      utc: new Date().toISOString(),
      ms: Number((performance.now() - epoch).toFixed(1)),
      pid: process.pid,
      ...data,
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("PR #165724 real gateway Talk forced-consult proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "adopts the recorded consult question and completes the backing agent answer while checking speech finalizes during consult startup",
    { timeout: 300_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot> | undefined;
      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr165724-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        // Backing agent provider: loopback OpenAI-Responses mock.
        const providerRequests: Array<{ at: string; input: unknown }> = [];
        providerServer = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            let input: unknown;
            try {
              input = JSON.parse(Buffer.concat(chunks).toString("utf8")).input;
            } catch {
              input = undefined;
            }
            providerRequests.push({ at: new Date().toISOString(), input });
            proof("backing-agent-request", {
              inputContainsQuestion: JSON.stringify(input ?? {}).includes(QUESTION),
            });
            const message = {
              type: "message",
              id: "pr165724-proof-message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: ANSWER, annotations: [] }],
            };
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...message, status: "in_progress", content: [] },
                },
                { type: "response.output_item.done", output_index: 0, item: message },
                {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                  },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .concat("data: [DONE]\n\n")
                .join(""),
            );
          })().catch(() => {
            response.writeHead(500).end("proof provider failed");
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        );

        // Realtime voice provider: a loopback bridge that reproduces the
        // released-version checking-acknowledgment sequence from #165683.
        let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
        const spokenPrompts: Array<{ at: string; text: string }> = [];
        const checkingPromptReceived = createDeferred();
        const spokenAnswer = createDeferred<string>();
        const bridge: RealtimeVoiceBridge = {
          supportsToolResultContinuation: true,
          supportsToolResultSuppression: true,
          connect: async () => undefined,
          sendAudio: () => undefined,
          setMediaTimestamp: () => undefined,
          handleBargeIn: () => undefined,
          acknowledgeMark: () => undefined,
          isConnected: () => true,
          close: () => undefined,
          submitToolResult: () => undefined,
          sendUserMessage: (text: string) => {
            spokenPrompts.push({ at: new Date().toISOString(), text });
            proof("bridge-send-user-message", { text: text.slice(0, 120) });
            if (text.includes("Briefly tell the person that you are checking")) {
              checkingPromptReceived.resolve();
            } else if (text.includes("OpenClaw finished checking")) {
              spokenAnswer.resolve(text);
            }
          },
        };
        const voiceProvider: RealtimeVoiceProviderPlugin = {
          id: VOICE_PROVIDER_ID,
          label: "PR #165724 proof voice provider",
          capabilities: {
            transports: ["gateway-relay"],
            inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
            outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
            supportsToolCalls: false,
          },
          isConfigured: () => true,
          createBridge: (request) => {
            bridgeRequest = request;
            return bridge;
          },
        };

        const cfg: OpenClawConfig = {
          skills: { load: { watch: false } },
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: {} },
          },
          talk: {
            agentId: "main",
            realtime: {
              provider: VOICE_PROVIDER_ID,
              mode: "realtime",
              transport: "gateway-relay",
              brain: "agent-consult",
              consultRouting: "force-agent-consult",
              instructions: "Answer briefly.",
              providers: { [VOICE_PROVIDER_ID]: {} },
            },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };

        // Register the loopback voice provider through the real plugin registry.
        registrySnapshot = captureActivePluginRegistrySnapshot();
        const runtime = createPluginRuntime();
        const registration = createPluginRegistry({ runtime, logger: console });
        const record = createPluginRecord({
          id: "pr165724-voice",
          source: "test",
          origin: "bundled",
          enabled: true,
          configSchema: true,
        });
        registration.registry.plugins.push(record);
        const api = registration.createApi(record, { config: cfg });
        api.registerRealtimeVoiceProvider(voiceProvider);
        setActivePluginRegistry(registration.registry);

        const forcedToolCall = createDeferred<{
          callId: string;
          args: Record<string, unknown>;
        }>();
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr165724-proof-client",
          onEvent: (evt) => {
            if (evt.event !== "talk.event") {
              return;
            }
            const payload = evt.payload as
              | { type?: string; callId?: string; forced?: boolean; args?: Record<string, unknown> }
              | undefined;
            if (payload?.type === "toolCall" && payload.forced === true && payload.callId) {
              forcedToolCall.resolve({ callId: payload.callId, args: payload.args ?? {} });
            }
          },
        });
        await gateway.server.startupSettled;
        // Minimal startup retains the real registration; re-assert it stays active.
        setActivePluginRegistry(registration.registry);
        proof("gateway-started", { port: gateway.port });

        const client = gateway.client;
        const target = prepareTalkSessionTarget(cfg, SESSION_KEY);
        const sessionId = await ensureClientVoiceAgentSessionEntry({
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
        });
        const readScope = {
          agentId: target.agentId,
          sessionId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        };

        // 1. Create the realtime gateway-relay Talk session.
        const session = await client.request<{ sessionId?: string; relaySessionId?: string }>(
          "talk.session.create",
          {
            mode: "realtime",
            transport: "gateway-relay",
            brain: "agent-consult",
            sessionKey: SESSION_KEY,
          },
        );
        const relaySessionId = session.relaySessionId ?? session.sessionId;
        expect(relaySessionId).toEqual(expect.any(String));
        proof("talk-session-created", { relaySessionId });
        expect(bridgeRequest).toBeDefined();

        // 2. The voice session is ready and the user asks the question.
        bridgeRequest!.onReady?.();
        bridgeRequest!.onTranscript?.("user", QUESTION, true);
        proof("user-final-transcript", { question: QUESTION });

        // 3. Forced consult fires and the client receives the forced tool call.
        const forced = await forcedToolCall.promise;
        proof("forced-consult-tool-call", { callId: forced.callId });

        // 4. Working result makes the relay speak the checking acknowledgment.
        await client.request("talk.session.submitToolResult", {
          sessionId: relaySessionId,
          callId: forced.callId,
          result: {
            status: "working",
            tool: "openclaw_agent_consult",
            message:
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
          },
          options: { willContinue: true },
        });
        await checkingPromptReceived.promise;
        proof("checking-acknowledgment-prompt-spoken");

        // 5. Start the agent consult (same trusted chat-send path as the browser UI).
        const consult = await client.request<{ runId: string }>("talk.client.toolCall", {
          sessionKey: SESSION_KEY,
          callId: forced.callId,
          name: "openclaw_agent_consult",
          args: forced.args,
          relaySessionId,
        });
        proof("consult-run-started", { runId: consult.runId });

        // 6. Wait for the persisted consult input row, then finalize the checking
        //    speech while the consult run is preparing its replay admission —
        //    the exact window from the #165683 released-version logs.
        const inputDeadline = Date.now() + 30_000;
        let inputRowSeenAt: number | undefined;
        for (;;) {
          const events = loadTranscriptEventsSync(readScope) as unknown as Array<
            Record<string, unknown>
          >;
          const inputRow = events.find((event) => {
            const message = event.message as
              | { role?: string; idempotencyKey?: unknown }
              | undefined;
            return (
              event.type === "message" &&
              message?.role === "user" &&
              typeof message.idempotencyKey === "string" &&
              message.idempotencyKey.endsWith(":user")
            );
          });
          if (inputRow) {
            inputRowSeenAt = Date.now();
            break;
          }
          if (Date.now() > inputDeadline) {
            throw new Error("consult input row was never persisted");
          }
          await sleep(5);
        }
        proof("consult-input-persisted", { seenAfterMs: inputRowSeenAt });
        bridgeRequest!.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "checking-response",
        });
        bridgeRequest!.onTranscript?.("assistant", CHECKING_SPEECH, true);
        proof("checking-speech-finalized", { speech: CHECKING_SPEECH });

        // The finalized speech must actually land in the shared transcript while
        // the consult run is still in flight (before its answer completes).
        const speechDeadline = Date.now() + 30_000;
        for (;;) {
          const eventsNow = loadTranscriptEventsSync(readScope);
          if (JSON.stringify(eventsNow).includes(CHECKING_SPEECH)) {
            proof("checking-speech-persisted", {});
            break;
          }
          if (Date.now() > speechDeadline) {
            throw new Error("checking speech was never persisted to the transcript");
          }
          await sleep(2);
        }

        // 7. The recorded question must reach the backing agent and complete.
        const waitResult = await client.request<{ status?: string; error?: unknown }>(
          "agent.wait",
          { runId: consult.runId, timeoutMs: 120_000 },
          { timeoutMs: 130_000 },
        );
        proof("consult-run-settled", { status: waitResult.status });
        expect(waitResult.status).toBe("ok");

        // 8. Deliver the answer back to the voice session (as the browser UI does).
        await client.request("talk.session.submitToolResult", {
          sessionId: relaySessionId,
          callId: forced.callId,
          result: { result: ANSWER },
        });
        const spoken = await Promise.race([
          spokenAnswer.promise,
          sleep(30_000).then(() => {
            throw new Error("the consult answer was never spoken back");
          }),
        ]);
        proof("consult-answer-spoken", { containsAnswer: spoken.includes(ANSWER) });
        expect(spoken).toContain(ANSWER);

        // 9. Final transcript keeps the question, the checking speech, and the answer.
        await sleep(500);
        const finalEvents = loadTranscriptEventsSync(readScope);
        const transcriptJson = JSON.stringify(finalEvents);
        proof("final-transcript", {
          hasQuestion: transcriptJson.includes(QUESTION),
          hasCheckingSpeech: transcriptJson.includes(CHECKING_SPEECH),
          hasAnswer: transcriptJson.includes(ANSWER),
        });
        expect(transcriptJson).toContain(QUESTION);
        expect(transcriptJson).toContain(CHECKING_SPEECH);
        expect(transcriptJson).toContain(ANSWER);

        // 10. The backing agent really received the recorded question.
        expect(providerRequests.length).toBeGreaterThan(0);
        const questionReachedBackingAgent = providerRequests.some((request) =>
          JSON.stringify(request.input ?? {}).includes(QUESTION),
        );
        proof("question-reached-backing-agent", {
          requests: providerRequests.length,
          questionReachedBackingAgent,
        });
        expect(questionReachedBackingAgent).toBe(true);

        await client
          .request("talk.session.close", { sessionId: relaySessionId })
          .catch(() => undefined);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        if (registrySnapshot) {
          restoreActivePluginRegistrySnapshot(registrySnapshot);
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
        closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
