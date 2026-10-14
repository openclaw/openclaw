/** Isolated Gateway and scripted provider for requester admission boundary proof. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../auto-reply/dispatch.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { Deferred } from "../shared/deferred.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  lastUserText,
  respond,
  toolResult,
} from "./gateway.sessions-send-provenance.provider-test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await cleanupProof();
    cleanup();
  }, 90_000),
);
const cleanups: Array<() => Promise<void>> = [];
export type ProofCase = {
  name: string;
  id: string;
  sender: string;
  agent: string;
  denied: boolean;
  busy?: boolean;
  mode?: "steer";
  bootstrap?: boolean;
  targetKey?: string;
};
type Outbound = { to: string; text: string; accountId?: string };
export type RunResult = { runId?: string; status?: string; error?: unknown };
type ModelRequest = { raw: string; tools: string[] };
export type ProofModelRequest = ModelRequest & {
  prompt: string;
  result?: Record<string, unknown>;
};
type ProofModelReply = { tool?: { name: string; args: unknown }; text?: string };
const modelScripts: Array<{
  marker: string;
  respond: (request: ProofModelRequest) => Promise<ProofModelReply> | ProofModelReply;
}> = [];

export function registerProofModelScript(
  marker: string,
  handleRequest: (request: ProofModelRequest) => Promise<ProofModelReply> | ProofModelReply,
) {
  modelScripts.push({ marker, respond: handleRequest });
}
export type Scenario = {
  spec: ProofCase;
  sourcePrompt: string;
  targetPrompt: string;
  marker: string;
  recipient: string;
  sourceRecipient: string;
  sourceKey: string;
  targetKey: string;
  sourceRequests: ModelRequest[];
  targetRequests: ModelRequest[];
  incumbentPrompt: string;
  incumbentRequests: ModelRequest[];
  incumbentStarted: Deferred;
  releaseIncumbent: Deferred;
  incumbentCompleted: boolean;
  bootstrapPrompt: string;
  bootstrapRequests: ModelRequest[];
  bootstrapAccepted?: Record<string, unknown>;
  accepted?: Record<string, unknown>;
  sourceCompleted: boolean;
  effectAfterSourceCompletion: boolean[];
  targetStarted: Deferred;
  releaseTarget: Deferred;
};
export const scenarios: Scenario[] = [];
export const outbound: Outbound[] = [];
export const providerErrors: string[] = [];
export let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
let gatewayKernel: Awaited<ReturnType<typeof import("./server-kernel.js").createGatewayKernel>>;
let gatewayContext: GatewayRequestContext;
let workspace: string;

function resetGatewayState() {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startProviderAndSink() {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "proof-model", object: "model" }] }));
        return;
      }
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      if (!isRecord(body)) {
        throw new Error("Expected a provider or sink object");
      }
      if (request.method === "POST" && request.url === "/sink") {
        if (typeof body.to !== "string" || typeof body.text !== "string") {
          throw new Error("Outbound sink requires a target and text");
        }
        outbound.push({
          to: body.to,
          text: body.text,
          ...(typeof body.accountId === "string" ? { accountId: body.accountId } : {}),
        });
        const scenario = scenarios.find((candidate) => candidate.marker === body.text);
        scenario?.effectAfterSourceCompletion.push(scenario.sourceCompleted);
        const incumbent = scenarios.find(
          (candidate) => `${candidate.marker}_INCUMBENT_1` === body.text,
        );
        if (incumbent) {
          incumbent.incumbentStarted.resolve();
          await incumbent.releaseIncumbent.promise;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ channel: "telegram", messageId: `sink-${outbound.length}` }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        throw new Error(`Unexpected proof request ${request.method} ${request.url}`);
      }
      const prompt = lastUserText(body);
      // These detached protocol steps are outside the effect being tested.
      const instructions =
        JSON.stringify(body.instructions ?? "") +
        JSON.stringify(
          (Array.isArray(body.input) ? body.input : []).filter(
            (item) => isRecord(item) && (item.role === "system" || item.role === "developer"),
          ),
        );
      if (
        instructions.includes("Agent-to-agent announce step:") ||
        prompt.includes("Agent-to-agent announce step.")
      ) {
        respond(response, undefined, "ANNOUNCE_SKIP");
        return;
      }
      if (instructions.includes("Agent-to-agent reply step:")) {
        respond(response, undefined, "REPLY_SKIP");
        return;
      }
      const modelRequest = {
        raw,
        tools: (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
          isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
        ),
      };
      const script = modelScripts.find((candidate) => prompt.includes(candidate.marker));
      if (script) {
        const reply = await script.respond({ ...modelRequest, prompt, result: toolResult(body) });
        respond(response, reply.tool, reply.text);
        return;
      }
      const scenario = scenarios.find(
        (candidate) =>
          prompt.includes(candidate.sourcePrompt) ||
          prompt.includes(candidate.targetPrompt) ||
          prompt.includes(candidate.incumbentPrompt) ||
          prompt.includes(candidate.bootstrapPrompt),
      );
      if (!scenario) {
        throw new Error(`Unexpected proof prompt ${prompt.slice(0, 300)}`);
      }
      if (prompt.includes(scenario.targetPrompt)) {
        scenario.targetRequests.push(modelRequest);
        if (scenario.targetRequests.length === 1) {
          scenario.targetStarted.resolve();
          await scenario.releaseTarget.promise;
          // Even a forbidden call is requested, so empty delivery proves enforcement,
          // rather than relying on the scripted provider to obey tool discovery.
          respond(response, {
            name: "message",
            args: {
              action: "send",
              channel: "telegram",
              target: scenario.recipient,
              message: scenario.marker,
              final: true,
            },
          });
        } else if (scenario.spec.bootstrap && scenario.targetRequests.length === 2) {
          respond(response, {
            name: "message",
            args: {
              action: "send",
              channel: "telegram",
              target: `${scenario.recipient}-incumbent`,
              message: `${scenario.marker}_INCUMBENT_2`,
            },
          });
        } else {
          respond(response, undefined, `TARGET_COMPLETE_${scenario.spec.id}`);
        }
        return;
      }
      if (prompt.includes(scenario.bootstrapPrompt)) {
        scenario.bootstrapRequests.push(modelRequest);
        if (scenario.bootstrapRequests.length === 1) {
          respond(response, {
            name: "sessions_send",
            args: {
              sessionKey: scenario.targetKey,
              mode: "followup",
              message: scenario.incumbentPrompt,
              timeoutSeconds: 0,
            },
          });
        } else {
          scenario.bootstrapAccepted = toolResult(body);
          respond(response, undefined, `BOOTSTRAP_COMPLETE_${scenario.spec.id}`);
        }
        return;
      }
      if (prompt.includes(scenario.incumbentPrompt)) {
        scenario.incumbentRequests.push(modelRequest);
        if (scenario.incumbentRequests.length <= 2) {
          respond(response, {
            name: "message",
            args: {
              action: "send",
              channel: "telegram",
              target: `${scenario.recipient}-incumbent`,
              message: `${scenario.marker}_INCUMBENT_${scenario.incumbentRequests.length}`,
            },
          });
        } else {
          respond(response, undefined, `INCUMBENT_COMPLETE_${scenario.spec.id}`);
        }
        return;
      }
      scenario.sourceRequests.push(modelRequest);
      if (scenario.sourceRequests.length === 1) {
        respond(response, {
          name: "sessions_send",
          args: {
            ...(scenario.spec.id === "delegate"
              ? { agentId: "deployment" }
              : { sessionKey: scenario.targetKey }),
            ...(scenario.spec.busy ? { mode: scenario.spec.mode ?? "followup" } : {}),
            message: scenario.targetPrompt,
            timeoutSeconds: 0,
          },
        });
      } else {
        scenario.accepted = toolResult(body);
        respond(response, undefined, `SOURCE_COMPLETE_${scenario.spec.id}`);
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors.push(message);
      console.error(`[provenance fixture] ${message}`);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
    });
  });
  const port = await acquireTestPortBlock({ offsets: [0] });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port.port, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    for (const scenario of scenarios) {
      scenario.releaseTarget.resolve();
      scenario.releaseIncumbent.resolve();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await port.release();
  });
  return `http://127.0.0.1:${port.port}`;
}

async function writeSinkPlugin(sinkUrl: string) {
  const directory = path.join(workspace, ".openclaw", "extensions", "provenance-sink");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "provenance-sink",
      channels: ["telegram"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  // The configured plugin owns synthetic channel I/O and group configuration.
  // Core policy composition, action dispatch, and execution admission stay real.
  await fs.writeFile(
    path.join(directory, "index.cjs"),
    `module.exports = {
      id: "provenance-sink",
      register(api) {
        api.registerChannel({ plugin: {
          id: "telegram",
          meta: { id: "telegram", label: "Proof sink", selectionLabel: "Proof sink", docsPath: "/proof", blurb: "Isolated proof transport" },
          capabilities: { chatTypes: ["direct", "group"] },
          reload: { configPrefixes: [], noopPrefixes: ["channels.telegram.groups"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({ accountId: "default", enabled: true, configured: true }),
            isEnabled: () => true,
            isConfigured: () => true,
          },
          actions: { describeMessageTool: () => ({ actions: ["send"], capabilities: [] }) },
          groups: {
            resolveToolPolicy: ({ cfg, groupId }) => cfg.channels?.telegram?.groups?.[groupId]?.tools,
          },
          messaging: {
            normalizeTarget: (value) => value,
            targetResolver: { looksLikeId: (value) => value.startsWith("provenance-") },
          },
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => to ? { ok: true, to } : { ok: false, error: new Error("Missing sink target") },
            async sendText({ to, text, accountId }) {
              const response = await fetch(${JSON.stringify(sinkUrl)}, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ to, text, accountId }),
              });
              if (!response.ok) throw new Error("Proof sink rejected delivery");
              return await response.json();
            },
          },
        } });
      },
    };`,
  );
  return directory;
}

beforeAll(async () => {
  resetGatewayState();
  const home = tempDirs.make("openclaw-sessions-provenance-");
  const stateDir = path.join(home, ".openclaw");
  workspace = path.join(home, "workspace");
  const emptyBundled = path.join(home, "empty-bundled-plugins");
  const environment = captureEnv([
    "HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  ]);
  cleanups.push(async () => environment.restore());
  const token = `provenance-proof-${randomUUID()}`;
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: emptyBundled,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    setTestEnvValue(key, value);
  }
  for (const key of [
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
  ]) {
    deleteTestEnvValue(key);
  }
  await Promise.all(
    [stateDir, workspace, emptyBundled].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  const endpoint = await startProviderAndSink();
  const sinkPlugin = await writeSinkPlugin(`${endpoint}/sink`);
  const provider = buildMockOpenAiResponsesProvider(`${endpoint}/v1`, "proof-model");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: {
        workspace,
        skipBootstrap: true,
        skills: [],
        model: { primary: provider.modelRef },
        models: { [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
      },
      entries: {
        main: {},
        research: { tools: { deny: ["message"] } },
        deployment: {},
        boundary: { tools: { profile: "full" } },
      },
    },
    gateway: { auth: { mode: "token", token } },
    hooks: { enabled: false },
    logging: { audit: { enabled: false, executionIdentity: false } },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: {
          ...provider.config,
          request: { allowPrivateNetwork: true },
        },
      },
    },
    plugins: {
      allow: ["provenance-sink"],
      entries: { "provenance-sink": { enabled: true } },
      load: { paths: [sinkPlugin] },
      slots: { memory: "none" },
    },
    channels: {
      telegram: {
        enabled: true,
        botToken: "123456:isolated-proof",
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: { "provenance-restricted": { tools: { deny: ["exec"] } } },
      },
    },
    tools: {
      profile: "messaging",
      toolSearch: false,
      codeMode: false,
      toolsBySender: { "id:guest": { deny: ["message"] } },
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["main", "research", "deployment"] },
    },
  };
  const kernelModule = await import("./server-kernel.js");
  const createKernel = kernelModule.createGatewayKernel;
  const capture = vi
    .spyOn(kernelModule, "createGatewayKernel")
    .mockImplementation(async (...args) => {
      const kernel = await createKernel(...args);
      gatewayKernel = kernel;
      gatewayContext = kernel.gatewayRequestContext;
      return kernel;
    });
  try {
    gateway = await startGatewayWithClient({
      cfg,
      configPath: path.join(stateDir, "openclaw.json"),
      token,
      portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    cleanups.push(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "requester provenance prototype complete" });
    });
    await gateway.server.startupSettled;
  } finally {
    capture.mockRestore();
  }
}, 90_000);

// Prepare the single test lifetime against this fixture's live Gateway registry.
beforeEach(async () => {
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  await withPluginRuntimeRegistryScope(gatewayKernel.pluginRuntime.registry, () =>
    refreshPreparedModelRuntimeSnapshots(getRuntimeConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      defaultWorkspaceDir: workspace,
    }),
  );
});

async function cleanupProof() {
  for (const scenario of scenarios) {
    scenario.releaseTarget.resolve();
    scenario.releaseIncumbent.resolve();
  }
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  resetGatewayState();
  if (errors.length) {
    throw new AggregateError(errors, "Requester provenance proof cleanup failed");
  }
}

export function runProofIngress(params: {
  abortSignal: AbortSignal;
  agentId: string;
  sessionKey: string;
  message: string;
  senderId: string;
  to: string;
  groupId?: string;
}) {
  // Identity comes from the trusted host/channel boundary, never model text.
  return withPluginRuntimeGatewayRequestScope(
    {
      resolveGatewayContext: gatewayContext.resolveGatewayContext,
      pluginRegistry: gatewayKernel.pluginRuntime.registry,
      isWebchatConnect: () => false,
    },
    () =>
      agentCommandFromIngress({
        abortSignal: params.abortSignal,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: randomUUID(),
        message: params.message,
        allowModelOverride: false,
        deliver: false,
        channel: "telegram",
        messageChannel: "telegram",
        messageProvider: "telegram",
        accountId: "default",
        to: params.to,
        runContext: {
          senderId: params.senderId,
          messageChannel: "telegram",
          accountId: "default",
          groupId: params.groupId,
          chatId: params.to,
        },
      }),
  );
}

export function createScenario(spec: ProofCase, sourceKey: string): Scenario {
  const scenario: Scenario = {
    spec,
    sourcePrompt: `PROVENANCE_SOURCE_${spec.id}`,
    targetPrompt: `PROVENANCE_TARGET_${spec.id}`,
    marker: `PROVENANCE_EFFECT_${spec.id}`,
    recipient: `provenance-${spec.id}`,
    sourceRecipient: `provenance-source-${spec.id}`,
    sourceKey,
    targetKey: spec.targetKey ?? (spec.id === "delegate" ? "agent:deployment:main" : sourceKey),
    sourceRequests: [],
    targetRequests: [],
    incumbentPrompt: `PROVENANCE_INCUMBENT_${spec.id}`,
    incumbentRequests: [],
    incumbentStarted: createDeferred(),
    releaseIncumbent: createDeferred(),
    incumbentCompleted: false,
    bootstrapPrompt: `PROVENANCE_BOOTSTRAP_${spec.id}`,
    bootstrapRequests: [],
    sourceCompleted: false,
    effectAfterSourceCompletion: [],
    targetStarted: createDeferred(),
    releaseTarget: createDeferred(),
  };
  scenarios.push(scenario);
  return scenario;
}

export const humanReplies: Array<{ sender: string; text?: string }> = [];
export function runHuman(
  scenario: Scenario,
  sender: string,
  prompt: string,
  mode: "steer" | "followup",
  signal: AbortSignal,
) {
  return withPluginRuntimeGatewayRequestScope(
    {
      resolveGatewayContext: gatewayContext.resolveGatewayContext,
      pluginRegistry: gatewayKernel.pluginRuntime.registry,
      isWebchatConnect: () => false,
    },
    () =>
      dispatchInboundMessageWithBufferedDispatcher({
        ctx: {
          Body: prompt,
          BodyForAgent: prompt,
          CommandBody: prompt,
          From: `telegram:group:${scenario.sourceRecipient}`,
          To: scenario.sourceRecipient,
          SessionKey: scenario.sourceKey,
          AccountId: "default",
          SenderId: sender,
          SenderName: sender,
          ChatType: "group",
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: scenario.sourceRecipient,
          MessageSid: randomUUID(),
          WasMentioned: true,
          CommandAuthorized: true,
          InboundAccessAuthorized: true,
          GroupSubject: "Synthetic shared conversation",
        },
        cfg: getRuntimeConfig(),
        dispatchReplyFromConfig: dispatchLowLevelChannelReplyFromConfig,
        dispatcherOptions: {
          deliver: async (payload) => {
            humanReplies.push({ sender, text: payload.text });
          },
        },
        replyOptions: { queueModeOverride: mode, disableBlockStreaming: true, abortSignal: signal },
      }),
  );
}
