import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const BACKEND_ID = "acp-native-model-fixture";
const MISSING_AUTH_PROVIDER_ID = "native-without-auth-fixture";
const ACP_MODEL = "harness-only[context=272k,reasoning=medium]";
const TOKEN = "acp-native-model-test-token";

type ChatEvent = {
  event?: string;
  payload?: {
    runId?: string;
    state?: string;
    text?: string;
    isError?: boolean;
    message?: unknown;
    errorMessage?: string;
  };
};

it(
  "keeps ACP conversations intact while native side questions use native policy and user overrides",
  { timeout: 120_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "acp-native-model",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    const requests: Array<{ model: string; input: unknown }> = [];
    const events: ChatEvent[] = [];
    let rejectNativeRequest = false;
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
          input: unknown;
        };
        requests.push(body);
        if (rejectNativeRequest) {
          response.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({
              error: {
                message: "The selected native model is unavailable.",
                type: "invalid_request_error",
                code: "model_not_found",
              },
            }),
          );
          return;
        }
        writeOpenAiResponsesText(response, {
          text: `NATIVE:${body.model}`,
          messageId: `native-message-${requests.length}`,
          responseId: `native-response-${requests.length}`,
        });
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let cfg: OpenClawConfig | undefined;
    const sessions: Array<{ agentId: string; sessionKey: string }> = [];
    const acpAnswers = new Map<string, string>();
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("native provider fixture did not bind");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const primary = buildMockOpenAiResponsesProvider(baseUrl, "native-default");
      const qualified = buildMockOpenAiResponsesProvider(baseUrl, "agent-specific-native");
      const override = buildMockOpenAiResponsesProvider(baseUrl, "native-user-override");
      const missingAuth = buildMockOpenAiResponsesProvider(
        "https://native-auth-proof.invalid/v1",
        "native-missing-auth",
      );
      const pluginDir = state.path("acp-plugin");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: BACKEND_ID,
          type: "commonjs",
          peerDependencies: { openclaw: ">=2026.9.5" },
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: BACKEND_ID,
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      // The only substituted execution boundary is the external ACP backend.
      await fs.writeFile(
        path.join(pluginDir, "index.cjs"),
        `const {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
} = require("openclaw/plugin-sdk/acp-runtime");
module.exports = {
  id: ${JSON.stringify(BACKEND_ID)},
  register(api) {
    const sessions = new Map();
    const keyFor = ({ agentId, sessionKey }) => JSON.stringify([agentId, sessionKey]);
    let sequence = 0;
    const runtime = {
      ownerAwareSessions: 1,
      async ensureSession(input) {
        const key = keyFor(input);
        let session = sessions.get(key);
        if (!session) {
          session = {
            handle: {
              agentId: input.agentId,
              sessionKey: input.sessionKey,
              backend: ${JSON.stringify(BACKEND_ID)},
              runtimeSessionName: input.sessionKey,
              backendSessionId: "fixture-" + ++sequence,
            },
            model: input.model,
          };
          sessions.set(key, session);
        } else if (input.model !== undefined) {
          session.model = input.model;
        }
        return session.handle;
      },
      getCapabilities() {
        return { controls: ["session/set_config_option"], configOptionKeys: ["model"] };
      },
      async setConfigOption({ handle, key, value }) {
        const session = sessions.get(keyFor(handle));
        if (key === "model") session.model = value;
        return { configOptions: [{ id: "model", currentValue: session.model }] };
      },
      async *runTurn({ handle }) {
        yield {
          type: "text_delta",
          text: "ACP:" + sessions.get(keyFor(handle)).model + ":" + handle.backendSessionId,
        };
        yield { type: "done", stopReason: "end_turn" };
      },
      async cancel() {},
      async close({ handle, discardPersistentState }) {
        if (discardPersistentState) sessions.delete(keyFor(handle));
      },
    };
    api.registerService({
      id: ${JSON.stringify(BACKEND_ID)},
      start() { registerAcpRuntimeBackend({ id: ${JSON.stringify(BACKEND_ID)}, runtime }); },
      stop() {
        unregisterAcpRuntimeBackend(${JSON.stringify(BACKEND_ID)});
        sessions.clear();
      },
    });
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  },
};
`,
      );
      const nativeModelSettings = {
        agentRuntime: { id: "openclaw" },
        params: { transport: "sse", openaiWsWarmup: false },
      };
      cfg = {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: primary.modelRef },
            models: {
              [primary.modelRef]: nativeModelSettings,
              [qualified.modelRef]: nativeModelSettings,
              [override.modelRef]: nativeModelSettings,
              [`${MISSING_AUTH_PROVIDER_ID}/${missingAuth.modelId}`]: nativeModelSettings,
            },
          },
          entries: {
            main: {
              model: ACP_MODEL,
              runtime: { type: "acp", acp: { agent: "cursor", backend: BACKEND_ID } },
            },
            qualified: {
              model: { primary: qualified.modelRef },
              runtime: { type: "acp", acp: { agent: "cursor", backend: BACKEND_ID } },
            },
          },
        },
        acp: { enabled: true, backend: BACKEND_ID, allowedAgents: ["cursor"] },
        models: {
          mode: "replace",
          providers: {
            [primary.providerId]: {
              ...primary.config,
              request: { allowPrivateNetwork: true },
              models: [
                ...primary.config.models,
                ...qualified.config.models,
                ...override.config.models,
              ],
            },
            // Loopback providers intentionally synthesize auth; this declared remote model
            // must fail before transport because it has no credentials or provider aliases.
            [MISSING_AUTH_PROVIDER_ID]: {
              baseUrl: missingAuth.config.baseUrl,
              api: missingAuth.config.api,
              models: missingAuth.config.models,
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [BACKEND_ID],
          load: { paths: [pluginDir] },
          entries: { [BACKEND_ID]: { enabled: true } },
          slots: { memory: "none" },
        },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token: TOKEN } },
      };
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: TOKEN,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => events.push(event as ChatEvent),
      });
      await gateway.server.startupSettled;
      const client = gateway.client;
      const plugins = await client.request<{
        plugins: Array<{ id: string; runtime: { state: string; error?: string } }>;
      }>("plugins.list", {});
      expect(plugins.plugins.find((plugin) => plugin.id === BACKEND_ID)).toMatchObject({
        runtime: { state: "active" },
      });
      const findTerminal = (runId: string) =>
        events.find(
          (event) =>
            event.event === "chat" &&
            event.payload?.runId === runId &&
            ["final", "error", "aborted"].includes(event.payload.state ?? ""),
        );
      const send = async (sessionKey: string, message: string, runId: string) => {
        await client.request("chat.send", { sessionKey, message, idempotencyKey: runId });
        await expect.poll(() => findTerminal(runId), { timeout: 30_000 }).toBeDefined();
        const terminal = findTerminal(runId);
        expect(terminal?.payload).toMatchObject({ state: "final" });
        return message.startsWith("/btw ")
          ? events.find(
              (event) => event.event === "chat.side_result" && event.payload?.runId === runId,
            )?.payload
          : { text: extractFirstTextBlock(terminal?.payload?.message) };
      };
      const manager = getAcpSessionManager();
      for (const { agentId, harnessModel } of [
        { agentId: "main", harnessModel: ACP_MODEL },
        { agentId: "qualified", harnessModel: qualified.modelRef },
      ]) {
        const sessionKey = `agent:${agentId}:acp:native-policy`;
        const initialized = await manager.initializeSession({
          cfg,
          agentId,
          sessionKey,
          agent: "cursor",
          backendId: BACKEND_ID,
          mode: "persistent",
          runtimeOptions: { model: harnessModel },
        });
        sessions.push({ agentId, sessionKey });
        const acpAnswer = `ACP:${harnessModel}:${initialized.handle.backendSessionId}`;
        acpAnswers.set(agentId, acpAnswer);
        const requestCount = requests.length;
        expect(await send(sessionKey, "Remember this ACP context.", `${agentId}-first`)).toEqual({
          text: acpAnswer,
        });
        expect(requests).toHaveLength(requestCount);
        expect(
          await send(sessionKey, "/btw Summarize that context.", `${agentId}-btw`),
        ).toMatchObject({
          text: `NATIVE:${primary.modelId}`,
          isError: false,
        });
        expect(requests.at(-1)?.model).toBe(primary.modelId);
        expect(JSON.stringify(requests.at(-1)?.input)).toContain(acpAnswer);
        expect(
          await send(sessionKey, "Continue the ACP conversation.", `${agentId}-second`),
        ).toEqual({
          text: acpAnswer,
        });
        expect(manager.resolveSession({ cfg, agentId, sessionKey })).toMatchObject({
          kind: "ready",
          entry: { sessionId: initialized.sessionEntry.sessionId },
          meta: {
            backend: BACKEND_ID,
            agent: "cursor",
            runtimeSessionName: initialized.meta.runtimeSessionName,
            runtimeOptions: { model: harnessModel },
          },
        });
      }

      const sessionKey = "agent:main:acp:native-policy";
      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
        providerOverride: override.providerId,
        modelOverride: override.modelId,
        modelOverrideSource: "user",
      }));
      expect(
        await send(sessionKey, "/btw Use my native selection.", "native-override"),
      ).toMatchObject({
        text: `NATIVE:${override.modelId}`,
        isError: false,
      });
      expect(requests.at(-1)?.model).toBe(override.modelId);

      rejectNativeRequest = true;
      expect(await send(sessionKey, "/btw Explain the failure.", "native-failure")).toMatchObject({
        text: expect.stringContaining("The selected native model is unavailable."),
        isError: true,
      });
      expect(requests.at(-1)?.model).toBe(override.modelId);
      const requestCount = requests.length;
      expect(
        await send(sessionKey, "Continue after the native failure.", "acp-after-failure"),
      ).toEqual({ text: acpAnswers.get("main") });
      expect(requests).toHaveLength(requestCount);
      expect(manager.resolveSession({ cfg, agentId: "main", sessionKey })).toMatchObject({
        kind: "ready",
        entry: {
          providerOverride: override.providerId,
          modelOverride: override.modelId,
          modelOverrideSource: "user",
        },
        meta: { runtimeOptions: { model: ACP_MODEL } },
      });

      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
        providerOverride: MISSING_AUTH_PROVIDER_ID,
        modelOverride: missingAuth.modelId,
        modelOverrideSource: "user",
      }));
      const missingAuthReply = await send(
        sessionKey,
        "/btw Use the native model without credentials.",
        "native-missing-auth",
      );
      expect(missingAuthReply).toMatchObject({
        text: expect.stringContaining(
          `No API key found for provider "${MISSING_AUTH_PROVIDER_ID}"`,
        ),
        isError: true,
      });
      expect(missingAuthReply?.text).toContain("openclaw models auth paste-api-key");
      expect(requests).toHaveLength(requestCount);
      expect(
        await send(sessionKey, "Continue after the missing native auth.", "acp-after-missing-auth"),
      ).toEqual({ text: acpAnswers.get("main") });
      expect(requests).toHaveLength(requestCount);
      expect(manager.resolveSession({ cfg, agentId: "main", sessionKey })).toMatchObject({
        kind: "ready",
        entry: {
          providerOverride: MISSING_AUTH_PROVIDER_ID,
          modelOverride: missingAuth.modelId,
          modelOverrideSource: "user",
        },
        meta: { runtimeOptions: { model: ACP_MODEL } },
      });
    } finally {
      try {
        if (cfg) {
          for (const session of sessions) {
            await getAcpSessionManager().closeSession({
              cfg,
              ...session,
              reason: "native model policy proof complete",
              clearMeta: true,
            });
          }
        }
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "native model policy proof complete" });
            }
          }
        } finally {
          providerServer.closeAllConnections();
          await new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          });
          await state.cleanup();
        }
      }
    }
  },
);
