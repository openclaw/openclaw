/** Isolated Gateway and scripted provider for requester admission boundary proof. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { readRequestText, respondJson } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../auto-reply/dispatch.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
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
  toolOutput,
  toolResult,
} from "./gateway.sessions-send-provenance.provider-test-support.js";
import {
  prepareProofSend,
  releaseProofSends,
  writeSinkPlugin,
} from "./gateway.sessions-send-provenance.transport.test-support.js";
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
export const requesterCase = (
  id: string,
  name: string,
  overrides: Partial<ProofCase> = {},
): ProofCase => ({ id, name, sender: "trusted", agent: "main", denied: false, ...overrides });
export const FOLLOWUP_REPLY =
  "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.";
export const STEERING_REFUSED_REPLY =
  "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.";
type Outbound = { to: string; text: string; accountId?: string };
export type RunResult = { runId?: string; status?: string; error?: unknown };
type ModelRequest = { tools: string[]; output: unknown };
export type ProofModelRequest = ModelRequest & {
  prompt: string;
  result?: Record<string, unknown>;
};
export type ProofModelReply = { tool?: { name: string; args: unknown }; text?: string };
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

export async function observeProofSteeringAdmission(prompt: string) {
  const injection = await import("../sessions/session-controller.message-injection.js");
  const admitted = createDeferred();
  const begin = injection.beginReplyMessageInjectionTarget;
  const observer = vi
    .spyOn(injection, "beginReplyMessageInjectionTarget")
    .mockImplementation(async (...args) => {
      const attempt = await begin(...args);
      if (args[1].includes(prompt)) {
        // Queue acceptance precedes transcript commitment while the incumbent is held.
        void attempt.acceptance.then((accepted) => {
          if (accepted) {
            admitted.resolve();
          }
        }, admitted.reject);
      }
      return attempt;
    });
  return {
    waitForAdmission: (source: Promise<unknown>, signal: AbortSignal) =>
      withinTest(
        awaitGateBeforeSettlement(
          admitted.promise,
          source,
          "Source settled before steering admission",
        ),
        signal,
      ),
    [Symbol.dispose]: () => observer.mockRestore(),
  };
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
  bootstrapRequestCount: number;
  bootstrapAccepted?: Record<string, unknown>;
  accepted?: Record<string, unknown>;
  sourceCompleted: boolean;
  effectAfterSourceCompletion: boolean[];
  targetStarted: Deferred;
  releaseTarget: Deferred;
};
const scenarios: Scenario[] = [];
export const outbound: Outbound[] = [];
export const providerErrors: string[] = [];
export let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
let gatewayKernel: Awaited<ReturnType<typeof import("./server-kernel.js").createGatewayKernel>>;
export let gatewayContext: GatewayRequestContext;
let workspace: string;

export function waitForProofGate(
  gate: Promise<unknown>,
  work: Promise<unknown>,
  signal: AbortSignal,
  message: string,
) {
  return withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
}

export const proofDeliveries = (to: string) => outbound.filter((entry) => entry.to === to);
const proofToolReply = (name: string, args: unknown) => ({ tool: { name, args } });
export const proofSend = (sessionKey: unknown, message: string, mode: "steer" | "followup") =>
  proofToolReply("sessions_send", { sessionKey, message, mode, timeoutSeconds: 0 });
export const proofSpawn = (
  task: string,
  options: { collect?: boolean; groupId?: string; expectsCompletionMessage?: boolean } = {},
) => proofToolReply("sessions_spawn", { task, cleanup: "keep", ...options });

export async function settleProofScenario(
  scenario: Scenario,
  work: readonly (Promise<unknown> | undefined)[],
) {
  scenario.releaseIncumbent.resolve();
  scenario.releaseTarget.resolve();
  await Promise.allSettled(work.filter((pending) => pending !== undefined));
  await waitForGatewayActiveWork(30_000);
}

export function waitForProofRun(runId: unknown): Promise<RunResult> {
  return gateway.client.request<RunResult>("agent.wait", { runId, timeoutMs: 30_000 });
}

function resetGatewayState() {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

async function startProviderAndSink() {
  const server = createServer((request, response) => {
    const sendTool = (name: string, args: unknown) => respond(response, { name, args });
    const sendMessage = (target: string, message: string, final?: true) =>
      sendTool("message", {
        action: "send",
        channel: "telegram",
        target,
        message,
        ...(final ? { final } : {}),
      });
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        respondJson(response, { data: [{ id: "proof-model", object: "model" }] });
        return;
      }
      const body: unknown = JSON.parse(await readRequestText(request));
      if (!isRecord(body)) {
        throw new Error("Expected a provider or sink object");
      }
      if (request.method === "POST" && request.url === "/prepare-send") {
        if (typeof body.to !== "string") {
          throw new Error("Send preparation requires a target");
        }
        await prepareProofSend(body.to);
        respondJson(response, {});
        return;
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
        respondJson(response, { channel: "telegram", messageId: `sink-${outbound.length}` });
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
        output: toolOutput(body),
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
          sendMessage(scenario.recipient, scenario.marker, true);
        } else if (scenario.spec.bootstrap && scenario.targetRequests.length === 2) {
          sendMessage(`${scenario.recipient}-incumbent`, `${scenario.marker}_INCUMBENT_2`);
        } else {
          respond(response, undefined, `TARGET_COMPLETE_${scenario.spec.id}`);
        }
        return;
      }
      if (prompt.includes(scenario.bootstrapPrompt)) {
        scenario.bootstrapRequestCount++;
        if (scenario.bootstrapRequestCount === 1) {
          sendTool("sessions_send", {
            sessionKey: scenario.targetKey,
            mode: "followup",
            message: scenario.incumbentPrompt,
            timeoutSeconds: 0,
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
          sendMessage(
            `${scenario.recipient}-incumbent`,
            `${scenario.marker}_INCUMBENT_${scenario.incumbentRequests.length}`,
          );
        } else {
          respond(response, undefined, `INCUMBENT_COMPLETE_${scenario.spec.id}`);
        }
        return;
      }
      scenario.sourceRequests.push(modelRequest);
      if (scenario.sourceRequests.length === 1) {
        sendTool("sessions_send", {
          ...(scenario.spec.id === "delegate"
            ? { agentId: "deployment" }
            : { sessionKey: scenario.targetKey }),
          ...(scenario.spec.busy ? { mode: scenario.spec.mode ?? "followup" } : {}),
          message: scenario.targetPrompt,
          timeoutSeconds: 0,
        });
      } else {
        scenario.accepted = toolResult(body);
        respond(response, undefined, `SOURCE_COMPLETE_${scenario.spec.id}`);
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors.push(message);
      console.error(`[provenance fixture] ${message}`);
      respondJson(response, { error: { message, type: "invalid_request_error" } }, 400);
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

beforeAll(async () => {
  resetGatewayState();
  const home = tempDirs.make("openclaw-sessions-provenance-");
  const stateDir = path.join(home, ".openclaw");
  workspace = path.join(home, "workspace");
  const emptyBundled = path.join(home, "empty-bundled-plugins");
  const token = `provenance-proof-${randomUUID()}`;
  const overrides = {
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: emptyBundled,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const cleared = [
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
  ];
  const environment = captureEnv([...Object.keys(overrides), ...cleared]);
  cleanups.push(async () => environment.restore());
  for (const [key, value] of Object.entries(overrides)) {
    setTestEnvValue(key, value);
  }
  for (const key of cleared) {
    deleteTestEnvValue(key);
  }
  await Promise.all(
    [stateDir, workspace, emptyBundled].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  const endpoint = await startProviderAndSink();
  const sinkPlugin = await writeSinkPlugin(workspace, `${endpoint}/sink`);
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
        deployment: { tools: { deny: ["sessions_history"] } },
        boundary: { tools: { profile: "full" } },
      },
    },
    gateway: { auth: { mode: "token", token } },
    hooks: { enabled: false },
    logging: { consoleLevel: "error", audit: { enabled: false, executionIdentity: false } },
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
  releaseProofSends();
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

function withProofRequestScope<T>(run: () => T): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      resolveGatewayContext: gatewayContext.resolveGatewayContext,
      pluginRegistry: gatewayKernel.pluginRuntime.registry,
      isWebchatConnect: () => false,
    },
    run,
  );
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
  return withProofRequestScope(() =>
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
    bootstrapRequestCount: 0,
    sourceCompleted: false,
    effectAfterSourceCompletion: [],
    targetStarted: createDeferred(),
    releaseTarget: createDeferred(),
  };
  scenarios.push(scenario);
  return scenario;
}

export const humanReplies: Array<{ sender: string; text?: string }> = [];

export async function patchProofConfig(
  patch: Record<string, unknown>,
  replacePaths: string[] = [],
) {
  const before = await gateway.client.request<{ hash: string }>("config.get", {});
  await gateway.client.request("config.patch", {
    baseHash: before.hash,
    raw: JSON.stringify(patch),
    replacePaths,
  });
}

export async function updateSenderPolicies(policies: Record<string, { deny: string[] | null }>) {
  await patchProofConfig(
    { tools: { toolsBySender: policies } },
    Object.entries(policies).flatMap(([senderKey, policy]) =>
      policy.deny === null ? [`tools.toolsBySender.${senderKey}.deny`] : [],
    ),
  );
}

export function configureProofCollaboration(allow: boolean | undefined, bobDenied = false) {
  return patchProofConfig(
    {
      messages: { queue: { allowCollaborativeSteering: allow ?? null } },
      tools: {
        toolsBySender: {
          "id:alice": { deny: null },
          "id:bob": { deny: bobDenied ? ["message"] : null },
        },
      },
    },
    [
      "messages.queue.allowCollaborativeSteering",
      "tools.toolsBySender.id:alice.deny",
      ...(!bobDenied ? ["tools.toolsBySender.id:bob.deny"] : []),
    ],
  );
}

export function dispatchProofHuman(
  ctx: MsgContext,
  sender: string,
  mode: "steer" | "followup",
  signal: AbortSignal,
) {
  return withProofRequestScope(() =>
    dispatchInboundMessageWithBufferedDispatcher({
      ctx,
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

export function runHuman(
  scenario: Scenario,
  sender: string,
  prompt: string,
  mode: "steer" | "followup",
  signal: AbortSignal,
  commandSource?: "text",
) {
  return dispatchProofHuman(
    {
      Body: prompt,
      BodyForAgent: prompt,
      CommandBody: prompt,
      CommandSource: commandSource,
      From: `telegram:group:${scenario.sourceRecipient}`,
      To: scenario.sourceRecipient,
      SessionKey: scenario.sourceKey,
      AccountId: "default",
      SenderId: sender,
      SenderName: sender,
      ChatType: "group",
      ChatId: scenario.sourceRecipient,
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
    sender,
    mode,
    signal,
  );
}
