import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";
import JSON5 from "json5";
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from "vitest";
import {
  loadDiscordReplyTypingFeedbackTestHarness,
  loadDiscordLivePolicyTestHarness,
  loadDiscordRuntimeTestHarness,
} from "../../extensions/discord/test-api.js";
import { finalizeInboundContext } from "../../src/auto-reply/reply/inbound-context.js";
import { createChannelReplyPipeline } from "../../src/channels/message/reply-pipeline.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  loadConfig,
  readConfigFileSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayServerOptions } from "../../src/gateway/server.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "../../src/infra/outbound/session-binding-service.js";
import { registerSealedRuntime } from "../../src/infra/sealed-runtime-registry.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../src/logging/logger.js";
import {
  writeOpenAiResponsesText,
  writeOpenAiResponsesSse,
} from "../helpers/openai-responses-sse.js";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { isCredentialEnvName } from "../vitest/credential-env-name.js";
import {
  createConfig,
  readBody,
  resolveTypingE2eScenario,
  listenLoopback,
  assertFixtureListenerOwner,
  closeServer,
  makeQuietToolPlugin,
  toolCallEvents,
  boundedWait,
  createFixtureWebSocketGuard,
  abortOwnedChild,
  activeTypingWaitRole,
  createLiveSubagentSampler,
  createTypingOwnerDiagnostic,
  emitTypingFailureEvidence,
  handleDiscordRest,
  type DiscordRestEvent,
  type ProviderRouteEvidence,
} from "./discord-typing-active.e2e-test-helpers.js";

// Defer the real asynchronous launch preparation, never its authorization result.
const approvalPreparation = vi.hoisted(() => ({
  active: false,
  entered: () => {},
  wait: Promise.resolve(),
}));
vi.mock("../../src/agents/shell-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agents/shell-snapshot.js")>();
  return {
    ...actual,
    maybeWrapCommandWithShellSnapshot: async (
      ...args: Parameters<typeof actual.maybeWrapCommandWithShellSnapshot>
    ) => {
      const command = await actual.maybeWrapCommandWithShellSnapshot(...args);
      if (approvalPreparation.active) {
        approvalPreparation.entered();
        await approvalPreparation.wait;
      }
      return command;
    },
  };
});

let beforeTypingResponse: ((event: DiscordRestEvent) => Promise<void> | undefined) | undefined;
let beforeApprovalExecToolCall: (() => Promise<void>) | undefined;
let beforeApprovalParentYield: (() => Promise<void>) | undefined;

type Scenario = "child" | "child-yield" | "child-error" | "child-cancel";
const approvalOnly = process.env.TYPING_REPRO_SCENARIO === "exec-approval";
const terminalScenarios: readonly Scenario[] = approvalOnly
  ? []
  : [resolveTypingE2eScenario(process.env.TYPING_REPRO_SCENARIO)];
const { createDiscordReplyTypingFeedback } = await loadDiscordReplyTypingFeedbackTestHarness();

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let scenario: Scenario = "child-yield";
const fixtureChannelIds = [
  "111111111111111111",
  "111111111111111112",
  "111111111111111113",
  "111111111111111114",
  "111111111111111115",
];
let nonce: string;
let fixtureRestBase: string;
const fixtureBindingAdapter: SessionBindingAdapter = {
  channel: "discord",
  accountId: "default",
  capabilities: { bindSupported: false, unbindSupported: false, placements: [] },
  listBySession: () => [],
  resolveByConversation: () => null,
};
let restEvents: DiscordRestEvent[] = [];
let model: Awaited<ReturnType<typeof startTextModel>>;
let config: OpenClawConfig;
let runRoot: string;
let channelId: string;
let guildId: string;
let unsubscribeEvents: (() => void) | undefined;
const agentEvidence: Array<Record<string, unknown>> = [];
let privateSuccessorStarted = false;
let gatewayPort: number;
const terminalRuns: Array<Record<string, unknown>> = [];
const liveSamples: Array<Record<string, unknown>> = [];
const typingOwnerDiagnostic = createTypingOwnerDiagnostic();
let sampleLive: (label: string) => Promise<void> = async () => {};
let resolveSuccessor: (() => void) | undefined;
let successorDelivered = new Promise<void>((resolve) => {
  resolveSuccessor = resolve;
});
let successorStartedAt: number | undefined, successorFinalAt: number | undefined;
const activeOverlapWaitStarts = new Set<"parent" | "child">();
let activeOverlapSample = createDeferred();
let activeOverlapSampleStarted = false;
let childRunId: string | undefined, childSessionKey: string | undefined;
let childToolStartedAt: number | undefined;
let childToolStarted = new Promise<void>(() => {});
let resolveChildToolStarted: (() => void) | undefined;
let cancelledTerminal = new Promise<void>(() => {});
let resolveCancelledTerminal: (() => void) | undefined;
let cancelAt: number | undefined;
let caseStartedAt: number | undefined, requesterReturnAt: number | undefined;
let successorWaitStartedAt: number | undefined, successorWaitTimeoutMs: number | undefined;
let recordPhase: (value: string) => Promise<void> = async () => {};
const modelServers: Array<{ close: () => Promise<void> }> = [];
const restServers: Array<{ close: () => Promise<void> }> = [];
let privateGateway: import("../../src/gateway/server.js").GatewayServer | undefined;
let nativeDiscordRuntime: import("../../src/plugins/runtime/types.js").PluginRuntime;
let runInDiscordContext: <T>(run: () => T) => T;
let restoreRuntimeFactoryBridge: (() => void) | undefined;
let restoreStageEnv: (() => void) | undefined;
let savedDiscordApiUrl: string | undefined;
let savedConfigPath: string | undefined;
let tempRoot: string;
let logPath: string;
let phasePath: string;
let fixtureConfigPath: string;
let originalFetch: typeof fetch;
const allowedLoopbackPorts = new Set<string>();
const blockedFetchTargets: string[] = [];
const websocketTargets: string[] = [];
const blockedWebSocketTargets: string[] = [];

beforeAll(async () => {
  const envNames = Object.keys(process.env).toSorted();
  process.stderr.write("[typing-e2e-env-names] " + JSON.stringify(envNames) + "\n");
  expect(
    envNames.filter(
      (name) =>
        isCredentialEnvName(name) ||
        (name.includes("GATEWAY") && !name.startsWith("OPENCLAW_TEST_")),
    ),
  ).toEqual([]);
  runRoot = tempDirs.make("openclaw-discord-typing-e2e-");
  tempRoot = path.join(runRoot, "runtime-tmp");
  logPath = path.join(runRoot, "application.log");
  phasePath = path.join(runRoot, "phases.txt");
  fixtureConfigPath = path.join(runRoot, "openclaw-config.json");
  nonce = "typing-e2e-" + randomUUID();
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await writeFile(phasePath, "");
  recordPhase = async (value) =>
    await appendFile(phasePath, Date.now() + " " + value + String.fromCharCode(10));
  sampleLive = createLiveSubagentSampler({
    agentEvidence,
    liveSamples,
    ownerDiagnostic: typingOwnerDiagnostic,
    recordPhase: (value) => recordPhase(value),
  });
  registerSealedRuntime({
    json5: JSON5,
    resolveSecureTempRoot: (options) =>
      resolveSecureTempRoot({ ...options, preferredDir: tempRoot }),
  });
  setLoggerOverride({ level: "debug", consoleLevel: "silent", file: logPath });
  originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.toString() : input,
    );
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !allowedLoopbackPorts.has(target.port)
    ) {
      blockedFetchTargets.push(target.origin + target.pathname);
      throw new Error("stage fetch blocked outside owned loopback fixture ports");
    }
    return await originalFetch(input, init);
  });
});

afterAll(async () => {
  const listenerOwnership = await Promise.allSettled(
    [...allowedLoopbackPorts].map((port) => assertFixtureListenerOwner(Number(port))),
  );
  unregisterSessionBindingAdapter({
    channel: "discord",
    accountId: "default",
    adapter: fixtureBindingAdapter,
  });
  typingOwnerDiagnostic.dispose();
  unsubscribeEvents?.();
  unsubscribeEvents = undefined;
  if (privateGateway) {
    await privateGateway.close({ reason: "typing-e2e-owned-teardown", drainTimeoutMs: 10_000 });
    privateGateway = undefined;
  }
  const [models, rests] = [modelServers.splice(0), restServers.splice(0)];
  const closed = await Promise.allSettled([
    ...models.map((item) => item.close()),
    ...rests.map((item) => item.close()),
  ]);
  expect(closed.filter((value) => value.status === "rejected")).toEqual([]);
  expect(listenerOwnership.filter((value) => value.status === "rejected")).toEqual([]);
  expect(blockedFetchTargets).toEqual([]);
  expect(blockedWebSocketTargets).toEqual([]);
  if (savedDiscordApiUrl === undefined) {
    delete process.env.DISCORD_API_URL;
  } else {
    process.env.DISCORD_API_URL = savedDiscordApiUrl;
  }
  if (savedConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
  }
  restoreRuntimeFactoryBridge?.();
  restoreRuntimeFactoryBridge = undefined;
  clearRuntimeConfigSnapshot();
  resetConfigRuntimeState();
  restoreStageEnv?.();
  vi.unstubAllGlobals();
  setLoggerOverride(null);
  resetLogger();
});

beforeAll(async () => {
  await writeFile(phasePath, "");
  recordPhase = async (value) => await appendFile(phasePath, Date.now() + " " + value + "\n");
  await recordPhase("begin");
  restEvents = [];
  const restServer = createServer((request, response) =>
    handleDiscordRest(
      request,
      response,
      nonce,
      restEvents,
      recordPhase,
      scenario === "child-error"
        ? "DISCORD_TYPING_CHILD_ERROR_SUCCESSOR_OK"
        : scenario === "child" || scenario === "child-yield"
          ? "DISCORD_TYPING_CHILD_SUCCESSOR_OK"
          : undefined,
      () => {
        successorFinalAt = Date.now();
        resolveSuccessor?.();
      },
      (event) => beforeTypingResponse?.(event),
    ),
  );
  await listenLoopback(restServer);
  restServers.push({ close: () => closeServer(restServer) });
  await recordPhase("discord-rest-listener-bound");
  const restAddress = restServer.address();
  if (!restAddress || typeof restAddress === "string") {
    throw new Error("Discord REST listener missing address");
  }
  allowedLoopbackPorts.add(String(restAddress.port));
  const restBase = "http://127.0.0.1:" + restAddress.port + "/api/v10";
  fixtureRestBase = restBase;
  expect(await (await fetch(restBase + "/identity")).json()).toEqual({
    nonce,
    port: restAddress.port,
  });
  savedDiscordApiUrl = process.env.DISCORD_API_URL;
  process.env.DISCORD_API_URL = restBase;
  model = await startTextModel(nonce);
  allowedLoopbackPorts.add(String(model.port));
  modelServers.push(model);
  expect(await (await fetch(model.url + "/identity")).json()).toEqual({ nonce, port: model.port });
  await recordPhase("openai-responses-listener-bound");
  channelId = "111111111111111111";
  guildId = "222222222222222222";

  await mkdir(path.join(runRoot, "discord-e2e-workspace"), { recursive: true });
  const envKeys = [
    "HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  ];
  const previous = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  restoreStageEnv = () => {
    for (const k of envKeys) {
      if (previous[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = previous[k];
      }
    }
  };
  process.env.HOME = path.join(runRoot, "home");
  process.env.OPENCLAW_STATE_DIR = path.join(runRoot, "state");
  await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  await mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
  for (const k of envKeys.slice(2)) {
    process.env[k] = "1";
  }
  // Repository-supported autostart hold retains channel config for real outbound recovery.
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  const { acquireGatewayE2ePortBlock, startClaimedGateway } =
    await import("../../src/gateway/test-helpers.listener.js");
  const gatewayClaim = await acquireGatewayE2ePortBlock();
  gatewayPort = gatewayClaim.port;
  const configDraft = createConfig(nonce, model.url, runRoot, guildId, channelId);
  configDraft.gateway = {
    mode: "local",
    bind: "loopback",
    port: gatewayClaim.port,
    auth: { mode: "token", token: nonce },
    controlUi: { enabled: false },
    roles: {
      default: "member",
      definitions: {
        admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
        member: {
          scopes: ["operator.read", "operator.write"],
          agents: "*",
          sessions: { others: "view" },
        },
      },
    },
  };
  // The synthetic sender is a real linked operator, not a forged CommandAuthorized flag.
  const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
  const { setUserProfileRole } = await import("../../src/state/user-profile-writes.worker.js");
  const { linkUserChannelIdentity } = await import("../../src/state/user-channel-identities.js");
  const { publishCanonicalUserChannelPolicy } =
    await import("../../src/state/user-channel-identity-operations.js");
  const operator = ensureProfileForEmail("typing-operator@example.test");
  setUserProfileRole(operator.id, "admin");
  linkUserChannelIdentity(operator.id, {
    channelId: "discord",
    accountId: "default",
    senderId: "333333333333333333",
  });
  await publishCanonicalUserChannelPolicy(
    configDraft.gateway,
    configDraft.commands?.ownerAllowFrom,
  );
  configDraft.update = { checkOnStart: false };
  configDraft.tools!.allow!.push("exec");
  configDraft.tools!.exec = { host: "gateway", mode: "ask", safeBins: [], notifyOnExit: false };
  configDraft.agents!.defaults!.typingIntervalSeconds = 1;
  for (const id of fixtureChannelIds) {
    configDraft.channels!.discord!.guilds![guildId]!.channels![id] = {
      enabled: true,
      requireMention: false,
      users: ["discord:333333333333333333"],
    };
  }
  const pluginDir = path.join(runRoot, "typing-fixture-plugin");
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "typing-fixture",
      name: "Typing Fixture",
      activation: { onStartup: true },
      contracts: { tools: ["typing_fixture_wait"] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await writeFile(
    path.join(pluginDir, "index.mjs"),
    makeQuietToolPlugin(path.join(runRoot, "tool-trace.jsonl")),
  );
  configDraft.plugins = {
    enabled: true,
    allow: ["discord", "typing-fixture"],
    load: { paths: [pluginDir] },
    entries: { discord: { enabled: true }, "typing-fixture": { enabled: true } },
    slots: { memory: "none" },
  };
  await writeFile(fixtureConfigPath, JSON.stringify(configDraft), { mode: 0o600 });
  await recordPhase("private-config-written");
  savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_CONFIG_PATH = fixtureConfigPath;
  resetConfigRuntimeState();
  const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, isolateEnv: true });
  if (!snapshot.valid) {
    throw new Error("synthetic OpenClaw config rejected: " + JSON.stringify(snapshot.issues));
  }
  await recordPhase("private-config-valid");
  config = loadConfig({ pin: false, skipPluginValidation: true, skipShellEnvFallback: true });
  setRuntimeConfigSnapshot(config);
  await recordPhase("runtime-config-set");
  const runtimeConfig = getRuntimeConfig();
  expect(runtimeConfig.agents?.defaults?.model).toEqual(config.agents?.defaults?.model);
  expect(runtimeConfig.models?.providers?.["typing-" + nonce]?.models?.[0]?.id).toBe(
    "typing-" + nonce,
  );
  // Native loading must use this source host's real factory, not a second core module graph.
  // Preserve the Gateway's options/base and all implementation behavior; bridge loading only.
  const sourceRuntime = await import("../../src/plugins/runtime/index.js");
  const runtimeResolution = await import("../../src/plugins/sdk-alias.js");
  const resolution = vi.spyOn(runtimeResolution, "resolvePluginRuntimeModulePathWithDiagnostics");
  const nativeModule = await import("../../src/plugins/native-module-require.js");
  const nativeLoad = nativeModule.tryNativeRequireModule;
  const factoryBridge = vi
    .spyOn(nativeModule, "tryNativeRequireModule")
    .mockImplementation((modulePath, options) => {
      if (modulePath === resolution.mock.results.at(-1)?.value?.resolvedPath) {
        return { ok: true, moduleExport: sourceRuntime };
      }
      return nativeLoad(modulePath, options);
    });
  restoreRuntimeFactoryBridge = () => {
    factoryBridge.mockRestore();
    resolution.mockRestore();
  };
  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const gatewayStartOptions: GatewayServerOptions = {
    bind: "loopback",
    host: "127.0.0.1",
    auth: { mode: "token", token: nonce },
    controlUiEnabled: false,
    channelAutostartSuppression: {
      reason: "crash-loop-breaker",
      message: "task-private fixture safety hold; never start live channel monitors",
    },
  };
  expect(gatewayStartOptions.channelAutostartSuppression).toMatchObject({
    reason: "crash-loop-breaker",
    message: expect.any(String),
  });
  await recordPhase("channel-autostart-suppression-runtime-asserted");
  await recordPhase("isolated-gateway-start");
  privateGateway = await startClaimedGateway(gatewayClaim, () =>
    startGatewayServer(gatewayClaim.port, gatewayStartOptions),
  );
  allowedLoopbackPorts.add(String(gatewayClaim.port));
  await assertFixtureListenerOwner(gatewayClaim.port);
  await recordPhase("listener-owner-verified " + gatewayClaim.port + " " + process.pid);
  const { connectGatewayClient, disconnectGatewayClient } =
    await import("../../src/gateway/test-helpers.e2e.js");
  const identityUrl = "ws://127.0.0.1:" + gatewayClaim.port;
  assertFixtureWebSocketTarget(identityUrl);
  const identityClient = await connectGatewayClient({ url: identityUrl, token: nonce });
  try {
    const identity = await identityClient.request<{ config: OpenClawConfig }>("config.get", {});
    expect(identity.config.models?.providers?.["typing-" + nonce]?.models?.[0]?.id).toBe(
      "typing-" + nonce,
    );
    expect(identity.config.gateway?.port).toBe(gatewayClaim.port);
  } finally {
    await disconnectGatewayClient(identityClient);
  }
  await recordPhase("isolated-gateway-ready-identity-verified");
  const { getDiscordRuntime } = await loadDiscordRuntimeTestHarness();
  const { getActivePluginRegistry } = await import("../../src/plugins/runtime.js");
  const { getPluginInstance } = await import("../../src/plugins/plugin-instance-scope.js");
  const registry = getActivePluginRegistry();
  const discord = registry?.plugins.find((plugin) => plugin.id === "discord");
  const instance = discord && getPluginInstance(discord);
  if (!registry || !instance) {
    throw new Error("Native Discord plugin instance is unavailable");
  }
  runInDiscordContext = instance.lifecycle.runInBackgroundContext;
  const realRuntime = runInDiscordContext(() => getDiscordRuntime());
  nativeDiscordRuntime = realRuntime;
  expect(realRuntime.channel.reply.finalizeInboundContext).toBe(finalizeInboundContext);
  await runInDiscordContext(async () => {
    expect(await realRuntime.gateway.isAvailable()).toBe(true);
  });
  await recordPhase("real-plugin-runtime-created");
  // The fixture disables thread bindings; keep real adapter selection/current-owner guards.
  registerSessionBindingAdapter(fixtureBindingAdapter);
  await recordPhase("discord-runtime-set");
  const channelInbound = await import("openclaw/plugin-sdk/channel-inbound");
  expect(vi.isMockFunction(channelInbound.dispatchChannelInboundTurn)).toBe(false);
  expect(vi.isMockFunction(realRuntime.channel.inbound.dispatch)).toBe(false);
  expect(
    vi.isMockFunction(realRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
  ).toBe(false);
  expect(vi.isMockFunction(realRuntime.agent.runEmbeddedAgent)).toBe(false);
  await import("../../src/auto-reply/reply/get-reply.js");
  const { getLoadedChannelPlugin } = await import("../../src/channels/plugins/index.js");
  const heartbeat = getLoadedChannelPlugin("discord")?.heartbeat;
  if (heartbeat?.sendTypingGuarded) {
    const original = heartbeat.sendTypingGuarded;
    heartbeat.sendTypingGuarded = async (params) => {
      try {
        return await original(params);
      } catch (error) {
        await recordPhase(
          "actual-guarded-typing-error-" +
            String(error) +
            "-" +
            (error instanceof Error ? error.stack : ""),
        );
        throw error;
      }
    };
  }
  await recordPhase("source-dispatch-modules-imported");
  const { onAgentEvent } = await import("../../src/infra/agent-events.js");
  const { hasLiveAgentRunContext, getAgentRunContext } =
    await import("../../src/infra/agent-run-registry.js");
  const { getSubagentRunByRunId } =
    await import("../../src/agents/subagents/registry/subagent-registry.js");
  const { isSubagentRunLive } =
    await import("../../src/agents/subagents/registry/subagent-run-liveness.js");
  unsubscribeEvents = onAgentEvent((evt) => {
    if (evt.stream !== "lifecycle" && evt.stream !== "tool") {
      return;
    }
    const entry = getSubagentRunByRunId(evt.runId);
    typingOwnerDiagnostic.observeAgentEvent(
      {
        runId: evt.runId,
        sessionKey: evt.sessionKey,
        stream: evt.stream,
        phase: evt.data.phase,
      },
      entry,
    );
    if (
      entry &&
      evt.stream === "lifecycle" &&
      (evt.data.phase === "end" || evt.data.phase === "error")
    ) {
      terminalRuns.push({
        runId: evt.runId,
        at: Date.now(),
        phase: evt.data.phase,
        data: evt.data,
      });
    }
    if (
      (scenario === "child-cancel" || scenario === "child-yield") &&
      entry &&
      evt.stream === "tool" &&
      evt.data.phase === "start" &&
      evt.data.name === "typing_fixture_wait"
    ) {
      childRunId = entry.runId;
      childSessionKey = entry.childSessionKey;
      childToolStartedAt = Date.now();
      resolveChildToolStarted?.();
      if (scenario === "child-yield") {
        typingOwnerDiagnostic.observeChildStart(entry);
      }
    }
    if (
      scenario === "child-cancel" &&
      entry &&
      evt.stream === "lifecycle" &&
      evt.data.phase === "error" &&
      evt.data.aborted === true &&
      evt.data.executionSettled === true
    ) {
      resolveCancelledTerminal?.();
    }
    agentEvidence.push({
      at: Date.now(),
      runId: evt.runId,
      sessionKey: evt.sessionKey,
      stream: evt.stream,
      phase: evt.data.phase,
      name: evt.data.name,
      live: hasLiveAgentRunContext(evt.runId),
      childLive: entry ? isSubagentRunLive(entry) : undefined,
      requesterTurnRunId: entry?.requesterTurnRunId,
      execution: entry?.execution,
      childSessionKey: entry?.childSessionKey,
      isChild: Boolean(entry),
      activity: getAgentRunContext(evt.runId)?.executionActivity,
    });
    const waitRole = activeTypingWaitRole(scenario, evt, Boolean(entry), privateSuccessorStarted);
    if (waitRole) {
      activeOverlapWaitStarts.add(waitRole);
      if (activeOverlapWaitStarts.size === 2) {
        if (!activeOverlapSampleStarted) {
          activeOverlapSampleStarted = true;
          const sampled = activeOverlapSample;
          void sampleLive("active-parent-and-child").then(
            () => sampled.resolve(),
            (error: unknown) => sampled.reject(error),
          );
        }
      }
    }
  });
}, 180000);

it(
  "executes real Discord source lifecycle cases through one owned Gateway",
  { timeout: 480_000 },
  async () => {
    onTestFailed(async () => {
      await flushLogger();
      await emitTypingFailureEvidence({
        scenario: approvalOnly ? "exec-approval" : scenario,
        caseStartedAt,
        requesterReturnAt,
        successorWaitStartedAt,
        successorWaitTimeoutMs,
        toolTracePath: runRoot ? path.join(runRoot, "tool-trace.jsonl") : undefined,
        agentEvidence,
        terminalRuns,
        liveSamples,
        providerRoutes: model?.routeEvidence ?? [],
        restEvents,
      });
    });
    for (const caseName of terminalScenarios) {
      scenario = caseName;
      caseStartedAt = Date.now();
      requesterReturnAt = undefined;
      typingOwnerDiagnostic.reset();
      successorWaitStartedAt = undefined;
      successorWaitTimeoutMs = undefined;
      channelId = fixtureChannelIds[terminalScenarios.indexOf(caseName)]!;
      model.reset();
      restEvents.length = 0;
      agentEvidence.length = 0;
      liveSamples.length = 0;
      terminalRuns.length = 0;
      activeOverlapWaitStarts.clear();
      activeOverlapSample = createDeferred();
      activeOverlapSampleStarted = false;
      privateSuccessorStarted = false;
      successorStartedAt = undefined;
      successorFinalAt = undefined;
      childRunId = undefined;
      childSessionKey = undefined;
      childToolStartedAt = undefined;
      cancelAt = undefined;
      childToolStarted = new Promise<void>((resolve) => {
        resolveChildToolStarted = resolve;
      });
      cancelledTerminal = new Promise<void>((resolve) => {
        resolveCancelledTerminal = resolve;
      });
      successorDelivered = new Promise<void>((resolve) => {
        resolveSuccessor = resolve;
      });
      await writeFile(path.join(runRoot, "tool-trace.jsonl"), "");
      await recordPhase("case-start-" + scenario);
      const marker = "DISCORD_TYPING_" + scenario.toUpperCase();
      const requesterSessionKey = "agent:main:discord:channel:" + channelId;
      const coreDispatchRuntimeEvents: string[] = [];
      const processEvents: string[] = [];
      const inbound = finalizeInboundContext({
        Body: marker,
        BodyForAgent: marker,
        RawBody: marker,
        CommandBody: marker,
        From: "discord:channel:" + channelId,
        To: "channel:" + channelId,
        SessionKey: requesterSessionKey,
        AccountId: "default",
        Provider: "discord",
        Surface: "discord",
        ChatType: "group",
        ConversationLabel: "Core-owned typing fixture",
        SenderId: "333333333333333333",
        SenderName: "Fixture User",
        MessageSid: "typing-e2e-message-" + scenario,
        OriginatingChannel: "discord",
        OriginatingTo: "channel:" + channelId,
        NativeChannelId: channelId,
        WasMentioned: true,
        CommandAuthorized: true,
        Timestamp: Date.now(),
      });
      const typingCallbacks = createDiscordReplyTypingFeedback({
        cfg: config,
        token: nonce,
        accountId: "default",
        channelId,
        log: (message) => {
          throw new Error(message);
        },
        keepaliveIntervalMs: 0,
        maxDurationMs: 0,
      });
      const pipeline = createChannelReplyPipeline({
        cfg: config,
        agentId: "main",
        channel: "discord",
        accountId: "default",
        typingCallbacks,
      });
      typingOwnerDiagnostic.bindRequest(requesterSessionKey, "main");
      expect(inbound.BodyForAgent).toContain(marker);
      expect(inbound.ChatType).toBe("group");
      await dispatchNativeDiscordReply({
        ctx: inbound,
        cfg: config,
        replyOptions: {
          onModelSelected: pipeline.onModelSelected,
          sourceReplyDeliveryMode: "message_tool_only",
        },
        dispatcherOptions: {
          ...pipeline,
          deliver: async (payload, info) => {
            if (!payload.text) {
              throw new Error("typing fixture expected an observable text delivery");
            }
            processEvents.push(info.kind + "-start");
            const response = await fetch(fixtureRestBase + "/channels/" + channelId + "/messages", {
              method: "POST",
              headers: { Authorization: "Bot " + nonce, "Content-Type": "application/json" },
              body: JSON.stringify({ content: payload.text }),
            });
            if (!response.ok) {
              throw new Error("fixture reply transport failed: " + response.status);
            }
            processEvents.push(info.kind + "-delivered");
          },
          onError: (error) => {
            coreDispatchRuntimeEvents.push("core-dispatch-error:" + String(error));
          },
        },
      });

      await typingOwnerDiagnostic.ready();
      const requesterFinishedAt = Date.now();
      requesterReturnAt = requesterFinishedAt;
      if (scenario === "child-yield") {
        expect(childToolStartedAt).toBeDefined();
        expect(childToolStartedAt!).toBeLessThan(requesterFinishedAt);
        expect(childRunId).toBeDefined();
        expect(childSessionKey).toBeDefined();
        const yieldedChildLiveAfterTypingExpiry = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void sampleLive("yielded-child-after-typing-expiry").then(resolve, reject);
          }, 132_000);
        });
        await boundedWait(
          yieldedChildLiveAfterTypingExpiry,
          140_000,
          "actual child liveness beyond the typing TTL",
        );
        const liveAfterExpiry = liveSamples.find(
          (sample) =>
            sample.label === "yielded-child-after-typing-expiry" &&
            sample.childLive === true &&
            sample.parentLive === false &&
            (sample.requesterTurnYielded === true || sample.yieldedPublicWakeOwner === true),
        );
        const liveAfterExpiryAt = liveAfterExpiry?.at;
        if (typeof liveAfterExpiryAt !== "number") {
          throw new Error("child liveness owner sample was missing after the typing TTL");
        }
        const typingAfterExpiry = restEvents.filter(
          (event) =>
            event.path === "/api/v10/channels/" + channelId + "/typing" &&
            event.at >= requesterFinishedAt + 120_000 &&
            event.at <= liveAfterExpiryAt,
        );
        expect(typingAfterExpiry.length).toBeGreaterThanOrEqual(2);
      }
      if (scenario === "child" || scenario === "child-yield" || scenario === "child-error") {
        const successorTimeoutMs = scenario === "child-error" ? 45_000 : 180_000;
        successorWaitStartedAt = Date.now();
        successorWaitTimeoutMs = successorTimeoutMs;
        await boundedWait(successorDelivered, successorTimeoutMs, "automatic successor delivery");
        await sampleLive("terminal-child-after-successor");
      } else if (scenario === "child-cancel") {
        await boundedWait(childToolStarted, 15_000, "actual child tool start");
        if (!childRunId || !childSessionKey) {
          throw new Error("cancellation fixture did not observe the actual child run");
        }
        const receipt = await abortOwnedChild(
          childRunId,
          childSessionKey,
          gatewayPort,
          nonce,
          assertFixtureWebSocketTarget,
          sampleLive,
        );
        cancelAt = Date.now();
        expect(receipt.aborted).toBe(true);
        await boundedWait(cancelledTerminal, 15_000, "aborted child terminal receipt");
        await sampleLive("terminal-child-after-cancel");
      }

      const diagnostics = JSON.stringify({
        scenario,
        route: { agentId: "main", sessionKey: requesterSessionKey },
        admission: "fixture-owned finalized core context; plugin preflight not claimed",
        processEvents,
        coreDispatchRuntimeEvents,
        modelPaths: model.paths,
        restPaths: restEvents.map((event) => event.path),
        websocketTargets,
        blockedFetchTargets,
        blockedWebSocketTargets,
      });
      expect(blockedFetchTargets, diagnostics).toEqual([]);
      expect(blockedWebSocketTargets, diagnostics).toEqual([]);
      expect(model.requests, diagnostics).toBeGreaterThanOrEqual(1);
      expect(restEvents.every((event) => event.authorization === "Bot " + nonce)).toBe(true);
      expect(model.authorization).toBe("Bearer " + nonce);
      expect(model.paths.every((value) => value === "POST /v1/responses")).toBe(true);
      const channelTyping = () =>
        restEvents.filter((event) => event.path === "/api/v10/channels/" + channelId + "/typing");
      const channelMessages = () =>
        restEvents.filter((event) => event.path === "/api/v10/channels/" + channelId + "/messages");
      if (scenario === "child-cancel") {
        expect(
          terminalRuns.some(
            (run) => run.phase === "error" && (run.data as { aborted?: boolean })?.aborted === true,
          ),
        ).toBe(true);
        expect(successorStartedAt).toBeUndefined();
        expect(channelTyping().filter((event) => event.at >= cancelAt!)).toHaveLength(0);
        expect(channelMessages().filter((event) => event.at >= cancelAt!)).toHaveLength(0);
      } else {
        expect(channelTyping().length).toBeGreaterThan(0);
        expect(channelMessages().length).toBeGreaterThan(0);
        expect(
          channelMessages().some((event) =>
            event.body?.includes(
              scenario === "child-error"
                ? "DISCORD_TYPING_CHILD_ERROR_SUCCESSOR_OK"
                : "DISCORD_TYPING_CHILD_SUCCESSOR_OK",
            ),
          ),
        ).toBe(true);
      }

      const trace = (await readFile(path.join(runRoot, "tool-trace.jsonl"), "utf8")).trim();
      const toolEvents = trace
        ? trace.split(String.fromCharCode(10)).map((line) => JSON.parse(line))
        : [];
      if (scenario === "child") {
        if (activeOverlapWaitStarts.size !== 2) {
          throw new Error("active parent/child liveness sampling did not start");
        }
        await activeOverlapSample.promise;
        const parentStart = toolEvents.find(
          (event) => event.phase === "start" && event.label === "parent",
        );
        const parentEnd = toolEvents.find(
          (event) => event.phase === "end" && event.label === "parent",
        );
        const childStart = toolEvents.find(
          (event) => event.phase === "start" && event.label === "child",
        );
        const childEnd = toolEvents.find(
          (event) => event.phase === "end" && event.label === "child",
        );
        expect(parentStart).toBeDefined();
        expect(parentEnd).toBeDefined();
        expect(childStart).toBeDefined();
        expect(childEnd).toBeDefined();
        expect(parentEnd.at - parentStart.at).toBeGreaterThan(120_000);
        expect(childStart.at).toBeLessThan(parentEnd.at);
        expect(childEnd.at).toBeGreaterThan(parentStart.at + 120_000);
        const active = liveSamples.find(
          (sample) => sample.label === "active-parent-and-child" && sample.childLive === true,
        );
        expect(active?.parentLive).toBe(true);
        expect(
          restEvents.some(
            (event) =>
              event.path === "/api/v10/channels/" + channelId + "/typing" &&
              event.at > parentStart.at + 122_000 &&
              event.at < parentEnd.at,
          ),
        ).toBe(true);
        const successorTyping = restEvents.filter(
          (event) =>
            event.path === "/api/v10/channels/" + channelId + "/typing" &&
            successorStartedAt !== undefined &&
            event.at >= successorStartedAt &&
            successorFinalAt !== undefined &&
            event.at <= successorFinalAt,
        );
        expect(successorTyping.length).toBeGreaterThan(0);
      }
      if (scenario === "child-error") {
        expect(terminalRuns.some((run) => run.phase === "error")).toBe(true);
      }
      if (scenario === "child-cancel") {
        expect(
          liveSamples.some(
            (sample) =>
              sample.label === "terminal-child-after-cancel" && sample.childLive === false,
          ),
        ).toBe(true);
      }
      if (scenario === "child-error" || scenario === "child" || scenario === "child-yield") {
        expect(
          liveSamples.some(
            (sample) =>
              String(sample.label).includes("terminal-child") && sample.childLive === false,
          ),
        ).toBe(true);
      }

      const finalTypingCount = channelTyping().length;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 7_500);
      });
      expect(channelTyping()).toHaveLength(finalTypingCount);
      process.stdout.write(
        "[typing-actual-producer-proof] " +
          JSON.stringify({
            scenario,
            typingRequests: finalTypingCount,
            childLiveBeyondTypingTtl: liveSamples.some(
              (sample) =>
                sample.label === "yielded-child-after-typing-expiry" && sample.childLive === true,
            ),
            childTerminalObserved: liveSamples.some(
              (sample) =>
                String(sample.label).includes("terminal-child") && sample.childLive === false,
            ),
            subsequentTypingAfterCleanup: channelTyping().length - finalTypingCount,
          }) +
          "\n",
      );
      if (scenario === "child-cancel") {
        expect(channelTyping().filter((event) => event.at >= cancelAt!)).toHaveLength(0);
        expect(channelMessages().filter((event) => event.at >= cancelAt!)).toHaveLength(0);
      }
    }
    // Shared test cleanup retires runtime owners after each test; keep this
    // second lifecycle phase inside the same owned Gateway fixture.
    if (approvalOnly) {
      caseStartedAt = Date.now();
    }
    await proveSupportedApprovalTyping();
  },
);

function dispatchNativeDiscordReply(
  params: Parameters<
    typeof nativeDiscordRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher
  >[0],
) {
  return runInDiscordContext(() =>
    nativeDiscordRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(params),
  );
}

async function proveSupportedApprovalTyping() {
  const { resolveGatewayClientBootstrap } = await import("../../src/gateway/client-bootstrap.js");
  const { withOperatorApprovalsGatewayClient } =
    await import("../../src/gateway/operator-approvals-client.js");
  const url = "ws://127.0.0.1:" + gatewayPort;
  assertFixtureWebSocketTarget(url);
  const bootstrap = await resolveGatewayClientBootstrap({ config, env: process.env });
  expect(bootstrap.url).toBe(url);
  expect(bootstrap.urlSource).toBe("local loopback");
  await withOperatorApprovalsGatewayClient(
    { config, clientDisplayName: "Discord typing native approval fixture" },
    proveSupportedApprovalTypingWithClient,
  );
}

async function proveSupportedApprovalTypingWithClient(
  approver: import("../../src/gateway/client.js").GatewayClient,
) {
  const { resolveApprovalOverGateway } =
    await import("../../src/infra/approval-gateway-resolver.js");
  const { onAgentEvent } = await import("../../src/infra/agent-events.js");
  const { getAgentRunContext } = await import("../../src/infra/agent-run-registry.js");
  const { getSubagentRunByRunId } =
    await import("../../src/agents/subagents/registry/subagent-registry.js");
  const { observeAgentRunHumanWait } = await import("../../src/agents/agent-run-approval-wait.js");
  const { createReplyBackgroundWorkObserver } =
    await import("../../src/auto-reply/reply/typing-background-work.runtime.js");
  const { createDiscordLivePolicyReader } = await loadDiscordLivePolicyTestHarness();
  const { writeConfigFile } = await import("../../src/config/config.js");
  const fixtureChannel = fixtureChannelIds[4]!;
  const sessionKey = "agent:main:discord:channel:" + fixtureChannel;
  const typingPath = "/api/v10/channels/" + fixtureChannel + "/typing";
  const typing = () => restEvents.filter((event) => event.path === typingPath);
  const execToolReady = createDeferred();
  const parentYielded = createDeferred();
  let handoffObserver: ReturnType<typeof createReplyBackgroundWorkObserver> | undefined;
  const pendingTyping = createDeferred<DiscordRestEvent>();
  const releasePendingTyping = createDeferred();
  let holdNextTyping = false;
  let atPendingStart = 0;
  const waiting = createDeferred<{ runId: string; approvalId: string }>();
  const resolved = createDeferred();
  const preparing = createDeferred();
  const releasePreparation = createDeferred();
  const executing = createDeferred();
  const childTerminal = createDeferred();
  let observedChildSession: string | undefined;
  let observedRun: string | undefined;
  let observedRequesterRun: string | undefined;
  let hasResolved = false;
  let hasExecuted = false;
  const phases: string[] = [];
  const transportErrors: string[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (
      event.runId === observedRequesterRun &&
      event.stream === "lifecycle" &&
      event.data.phase === "end"
    ) {
      parentYielded.resolve();
    }
    const child = getSubagentRunByRunId(event.runId);
    if (!child || child.requesterSessionKey !== sessionKey) {
      return;
    }
    observedRun ??= event.runId;
    observedRequesterRun ??= child.requesterTurnRunId;
    observedChildSession ??= child.childSessionKey;
    if (
      event.stream === "lifecycle" &&
      event.data.phase === "waiting-approval" &&
      typeof event.data.approvalId === "string"
    ) {
      observedRun = event.runId;
      observedChildSession = child.childSessionKey;
      phases.push("native-approval-wait");
      waiting.resolve({ runId: event.runId, approvalId: event.data.approvalId });
    }
    if (event.runId !== observedRun) {
      return;
    }
    if (
      event.stream === "lifecycle" &&
      (event.data.phase === "end" || event.data.phase === "error")
    ) {
      phases.push("native-child-terminal");
      childTerminal.resolve();
    }
    if (event.stream === "lifecycle" && event.data.phase === "approval-resolved") {
      hasResolved = true;
      phases.push("native-approval-resolved");
      resolved.resolve();
    }
    if (hasResolved && event.stream === "execution" && event.data.state === "running") {
      hasExecuted = true;
      phases.push("native-execution-running");
      executing.resolve();
    }
  });
  beforeApprovalExecToolCall = async () => {
    // Coordinate the synthetic model, not approval state: the native start must still
    // be in flight within Discord's production deadline when real approval begins.
    const child = observedRun && getSubagentRunByRunId(observedRun);
    if (!child || !child.requesterTurnRunId) {
      throw new Error("Native executing child has no exact requester turn owner");
    }
    handoffObserver = createReplyBackgroundWorkObserver({
      sessionKey,
      runId: child.requesterTurnRunId,
      onChange: () => {},
    });
    execToolReady.resolve();
    await boundedWait(parentYielded.promise, 20_000, "real requester yield after child readiness");
    const state = handoffObserver.currentState();
    process.stdout.write("[typing-native-handoff-owner] " + state + "\n");
    expect(state).toBe("active");
    phases.push("real-requester-yield-after-child-ready");
    holdNextTyping = true;
    await boundedWait(pendingTyping.promise, 5000, "owned typing start before real exec tool call");
  };
  beforeApprovalParentYield = async () => {
    await boundedWait(execToolReady.promise, 60_000, "native child model before requester yield");
  };
  beforeTypingResponse = (event) => {
    if (event.path === typingPath && holdNextTyping) {
      holdNextTyping = false;
      atPendingStart = typing().length;
      pendingTyping.resolve(event);
      return releasePendingTyping.promise;
    }
    return undefined;
  };
  approvalPreparation.wait = releasePreparation.promise;
  approvalPreparation.entered = () => {
    phases.push("real-launch-preparation-held");
    preparing.resolve();
  };

  let humanWait: ReturnType<typeof observeAgentRunHumanWait> | undefined;
  let dispatch: Promise<unknown> | undefined;
  let dispatchError: unknown;
  const policy = await createDiscordLivePolicyReader({
    cfg: config,
    accountId: "default",
    token: nonce,
    readConfig: getRuntimeConfig,
  })();
  expect(policy.isCurrent()).toBe(true);
  try {
    model.reset();
    const marker = "EXEC_APPROVAL_TYPING_TASK";
    const ingress = await nativeDiscordRuntime.channel.inbound.ingress.resolveStable({
      channelId: "discord",
      accountId: "default",
      identity: { authentication: "verified" },
      subject: { stableId: "333333333333333333" },
      conversation: { kind: "group", id: fixtureChannel },
      contextBinding: {
        agentId: "main",
        sessionKey,
        messageId: "typing-exec-approval",
        nativeChannelId: fixtureChannel,
        inboundEventKind: "user_request",
      },
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: ["333333333333333333"],
      groupAllowFrom: ["333333333333333333"],
      useDefaultPairingStore: false,
    });
    const admitted = nativeDiscordRuntime.channel.inbound.buildContext({
      channel: "discord",
      accountId: "default",
      messageId: "typing-exec-approval",
      from: "discord:channel:" + fixtureChannel,
      sender: { id: "333333333333333333", name: "Fixture User" },
      conversation: { kind: "group", id: fixtureChannel, nativeChannelId: fixtureChannel },
      route: { agentId: "main", routeSessionKey: sessionKey },
      reply: { to: "channel:" + fixtureChannel, nativeChannelId: fixtureChannel },
      message: { rawBody: marker, inboundEventKind: "user_request" },
      channelIngress: ingress,
    });
    const inbound = finalizeInboundContext({
      ...admitted,
      Body: marker,
      BodyForAgent: marker,
      RawBody: marker,
      CommandBody: marker,
      From: "discord:channel:" + fixtureChannel,
      To: "channel:" + fixtureChannel,
      SessionKey: sessionKey,
      AccountId: "default",
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      SenderId: "333333333333333333",
      SenderName: "Fixture User",
      MessageSid: "typing-exec-approval",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:" + fixtureChannel,
      NativeChannelId: fixtureChannel,
      WasMentioned: true,
      CommandAuthorized: true,
      Timestamp: Date.now(),
    });
    const { prepareInternalGetReplyOptions } =
      await import("../../src/auto-reply/reply/get-reply.types.js");
    const requester = prepareInternalGetReplyOptions(undefined, inbound)?.operatorAuthority;
    expect(requester?.scopes).toContain("operator.admin");
    requester?.assertCurrent();
    const callbacks = createDiscordReplyTypingFeedback({
      cfg: config,
      token: nonce,
      accountId: "default",
      channelId: fixtureChannel,
      isCurrent: policy.isCurrent,
      keepaliveIntervalMs: 0,
      maxDurationMs: 0,
      log: (message) => {
        transportErrors.push(message);
      },
    });
    const pipeline = createChannelReplyPipeline({
      cfg: config,
      agentId: "main",
      channel: "discord",
      accountId: "default",
      typingCallbacks: callbacks,
    });
    dispatch = dispatchNativeDiscordReply({
      ctx: inbound,
      cfg: config,
      replyOptions: {
        onModelSelected: pipeline.onModelSelected,
        sourceReplyDeliveryMode: "message_tool_only",
      },
      dispatcherOptions: {
        ...pipeline,
        deliver: async (payload) => {
          if (!payload.text) {
            return;
          }
          const response = await fetch(
            fixtureRestBase + "/channels/" + fixtureChannel + "/messages",
            {
              method: "POST",
              headers: { Authorization: "Bot " + nonce, "Content-Type": "application/json" },
              body: JSON.stringify({ content: payload.text }),
            },
          );
          expect(response.ok).toBe(true);
        },
        onError: (error) => {
          dispatchError = error;
        },
      },
    });
    void dispatch.catch((error: unknown) => {
      dispatchError = error;
    });
    await boundedWait(execToolReady.promise, 60_000, "real registered child model ready for exec");
    const first = await boundedWait(
      pendingTyping.promise,
      20_000,
      "actual pending Discord typing request",
    );
    const approval = await boundedWait(waiting.promise, 20_000, "native supported exec approval");
    humanWait = observeAgentRunHumanWait({
      runId: approval.runId,
      sessionKey: observedChildSession,
    });
    expect(humanWait.waiting).toBe(true);
    expect(first.responseFinished).not.toBe(true);
    expect(typing()).toHaveLength(atPendingStart);
    releasePendingTyping.resolve();
    await vi.waitFor(() => expect(first.responseFinished).toBe(true), { timeout: 5000 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2500);
    });
    expect(typing()).toHaveLength(atPendingStart);
    phases.push("late-start-settled-during-native-wait");
    approvalPreparation.active = true;
    const decision = await resolveApprovalOverGateway({
      cfg: config,
      approvalId: approval.approvalId,
      approvalKind: "exec",
      decision: "allow-once",
      channel: "discord",
      accountId: "default",
      senderId: "333333333333333333",
      gatewayRuntime: { request: (method, params) => approver.request(method, params) },
    });
    expect(decision).toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    await boundedWait(resolved.promise, 5000, "native approval answer");
    await boundedWait(preparing.promise, 5000, "real exec preparation after approval");
    expect(humanWait.waiting).toBe(false);
    expect(humanWait.resumeRequired).toBe(true);
    expect(hasExecuted).toBe(false);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2500);
    });
    expect(typing()).toHaveLength(atPendingStart);
    releasePreparation.resolve();
    await boundedWait(executing.promise, 5000, "matching native exec running event");
    await vi.waitFor(() => expect(typing().length).toBeGreaterThan(atPendingStart), {
      timeout: 5000,
    });
    expect(humanWait.resumeRequired).toBe(false);
    expect(getAgentRunContext(approval.runId)?.executionActivity?.execution?.state).toBe("running");
    phases.push("actual-producer-resumed-after-native-execution");
    const revoked = structuredClone(config);
    revoked.channels!.discord!.groupPolicy = "disabled";
    await writeConfigFile(revoked);
    setRuntimeConfigSnapshot(revoked);
    expect(
      (await readConfigFileSnapshot({ skipPluginValidation: true, isolateEnv: true })).config
        .channels?.discord?.groupPolicy,
    ).toBe("disabled");
    expect(policy.isCurrent()).toBe(false);
    const atRevocation = typing().length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2500);
    });
    expect(typing()).toHaveLength(atRevocation);
    expect(getAgentRunContext(approval.runId)).toBeDefined();
    phases.push("canonical-policy-revoked-zero-subsequent-typing");
    await boundedWait(dispatch, 20_000, "actual requester yield");
    await boundedWait(
      childTerminal.promise,
      20_000,
      "actual approved child exec and terminal cleanup",
    );
    expect(dispatchError).toBeUndefined();
    expect(transportErrors).toEqual([]);
    const terminal = typing().length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2500);
    });
    expect(typing()).toHaveLength(terminal);
    expect(blockedFetchTargets).toEqual([]);
    expect(blockedWebSocketTargets).toEqual([]);
    process.stdout.write(
      "[typing-exec-approval-proof] " +
        JSON.stringify({
          phases,
          typingRequests: terminal,
          typingRequestsBeforePause: atPendingStart,
          nativeApproval: true,
          canonicalNativeApprover: true,
          nativeExecution: hasExecuted,
          pendingStartSettledWhileWaiting: true,
          answeredPreparationStayedSilent: true,
          actualPolicyInvalidated: !policy.isCurrent(),
          subsequentTyping: typing().length - atRevocation,
        }) +
        "\n",
    );
  } catch (error) {
    process.stderr.write(
      "[typing-native-journey-failure] " +
        String(error).replaceAll(nonce, "[fixture-token]").replaceAll(runRoot, "[fixture-root]") +
        "\n",
    );
    throw error;
  } finally {
    releasePendingTyping.resolve();
    execToolReady.resolve();
    parentYielded.resolve();
    releasePreparation.resolve();
    approvalPreparation.active = false;
    beforeTypingResponse = undefined;
    beforeApprovalExecToolCall = undefined;
    beforeApprovalParentYield = undefined;
    humanWait?.dispose();
    handoffObserver?.dispose();
    unsubscribe();
    const { isSubagentRunLive } =
      await import("../../src/agents/subagents/registry/subagent-run-liveness.js");
    const child = observedRun ? getSubagentRunByRunId(observedRun) : undefined;
    if (observedRun && observedChildSession && child && isSubagentRunLive(child)) {
      await abortOwnedChild(
        observedRun,
        observedChildSession,
        gatewayPort,
        nonce,
        assertFixtureWebSocketTarget,
        async () => {},
      );
    }
    if (dispatch) {
      await boundedWait(
        dispatch.catch(() => undefined),
        20_000,
        "owned exec dispatch cleanup",
      );
    }
  }
}

async function startTextModel(modelNonce: string) {
  let requests = 0;
  let parentStep = 0;
  let childStep = 0;
  let successorStep = 0;
  let approvalStep = 0;
  let approvalParentStep = 0;
  let authorization: string | undefined;
  const paths: string[] = [];
  const routeEvidence: ProviderRouteEvidence[] = [];
  const server = createServer((request, response) => {
    void handleModelRequest(request, response).catch((error: unknown) => {
      void recordPhase("fixture-model-handler-error-" + String(error));
      process.stderr.write(
        "[typing-fixture-model-error] " +
          String(error)
            .replaceAll(modelNonce, "[fixture-token]")
            .replaceAll(runRoot, "[fixture-root]") +
          "\n",
      );
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({ error: { message: "Fixture request rejected: " + String(error) } }),
      );
    });
  });
  async function handleModelRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "GET" && request.url === "/identity") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({ nonce: modelNonce, port: (server.address() as { port: number }).port }),
        );
      return;
    }
    paths.push((request.method ?? "?") + " " + (request.url ?? ""));
    void recordPhase("model-request-" + (request.url ?? "unknown"));
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    requests += 1;
    authorization = request.headers.authorization;
    if (authorization !== "Bearer " + modelNonce) {
      response.writeHead(401).end();
      return;
    }
    const respondTool = (name: string, args: Record<string, unknown>) => {
      expect(JSON.parse(body).tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name })]),
      );
      writeOpenAiResponsesSse(response, toolCallEvents(name, args, requests));
    };
    const input = JSON.parse(body).input as Array<{
      role?: string;
      type?: string;
      content?: unknown;
      output?: unknown;
    }>;
    const userText = JSON.stringify(
      input.filter((item) => item.role === "user").map((item) => item.content),
    );
    if (userText.includes("EXEC_APPROVAL_TYPING_TASK") && !userText.includes("[Subagent Task]")) {
      if (approvalParentStep > 0) {
        const outputs = input
          .filter((item) => item.type === "function_call_output")
          .map((item) =>
            typeof item.output === "string" ? item.output : JSON.stringify(item.output),
          )
          .join("\n")
          .replaceAll(modelNonce, "[fixture-token]")
          .replaceAll(runRoot, "[fixture-root]");
        if (outputs.includes('"status": "error"') || outputs.includes('"status":"error"')) {
          process.stderr.write(
            "[typing-native-parent-tool-results] " + outputs.slice(-2400) + "\n",
          );
        }
      }
      if (approvalParentStep === 0) {
        approvalParentStep++;
        respondTool("sessions_spawn", {
          taskName: "approval_typing_child",
          task: "EXEC_APPROVAL_CHILD_TASK",
          context: "isolated",
          runTimeoutSeconds: 90,
        });
      } else if (approvalParentStep++ === 1) {
        await beforeApprovalParentYield?.();
        respondTool("sessions_yield", {});
      } else {
        writeOpenAiResponsesText(response, {
          text: "EXEC_APPROVAL_CHILD_SETTLED",
          messageId: "msg_" + requests,
          responseId: "resp_" + requests,
        });
      }
      return;
    }
    if (userText.includes("EXEC_APPROVAL_CHILD_TASK")) {
      if (approvalStep++ === 0) {
        await beforeApprovalExecToolCall?.();
        respondTool("exec", {
          command:
            JSON.stringify(process.execPath) +
            " -e " +
            JSON.stringify(
              "setTimeout(() => process.stdout.write('EXEC_APPROVAL_NATIVE_RESUMED'), 12000)",
            ),
          workdir: path.join(runRoot, "discord-e2e-workspace"),
          yieldMs: 20000,
          timeoutSeconds: 30,
        });
      } else {
        const toolOutputs = input
          .filter((item) => item.type === "function_call_output")
          .map((item) =>
            typeof item.output === "string" ? item.output : JSON.stringify(item.output),
          )
          .join("\n");
        // The command itself contains this marker; only actual tool output proves execution.
        if (!toolOutputs.includes("EXEC_APPROVAL_NATIVE_RESUMED")) {
          const detail = toolOutputs
            .replaceAll(modelNonce, "[fixture-token]")
            .replaceAll(runRoot, "[fixture-root]")
            .slice(-1200);
          process.stderr.write("[typing-native-exec-result] " + detail + "\n");
          throw new Error("native exec did not return its required execution marker");
        }
        writeOpenAiResponsesText(response, {
          text: "EXEC_APPROVAL_TYPING_DONE",
          messageId: "msg_" + requests,
          responseId: "resp_" + requests,
        });
      }
      return;
    }
    const isChildRequest =
      userText.includes("[Subagent Task]") && userText.includes("CHILD_LINKED_TYPING_TASK");
    await recordPhase(
      "provider-route-" + (isChildRequest ? "child" : "parent") + "-request-" + requests,
    );
    const linkedScenario = terminalScenarios.includes(scenario as Scenario);
    const completionPrompt =
      !isChildRequest && userText.includes("Every subagent in this batch has now settled");
    const routeEvent: ProviderRouteEvidence = {
      at: Date.now(),
      route: isChildRequest ? "child" : "parent",
      completionPrompt,
    };
    routeEvidence.push(routeEvent);
    response.once("finish", () => {
      routeEvent.responseStatus = response.statusCode;
      routeEvent.responseFinishedAt = Date.now();
    });
    if (linkedScenario && completionPrompt) {
      successorStartedAt ??= Date.now();
      privateSuccessorStarted = true;
      if (successorStep++ === 0) {
        respondTool("typing_fixture_wait", {
          label: "successor",
          durationMs: scenario === "child" ? 10000 : 3000,
        });
        return;
      }
      writeOpenAiResponsesText(response, {
        text:
          scenario === "child-error"
            ? "DISCORD_TYPING_CHILD_ERROR_SUCCESSOR_OK"
            : "DISCORD_TYPING_CHILD_SUCCESSOR_OK",
        messageId: "msg_" + requests,
        responseId: "resp_" + requests,
      });
      return;
    }
    if (linkedScenario && isChildRequest) {
      if (childStep++ === 0) {
        respondTool("typing_fixture_wait", {
          label: "child",
          durationMs:
            scenario === "child"
              ? 165000
              : scenario === "child-yield"
                ? 160000
                : scenario === "child-cancel"
                  ? 60000
                  : 10000,
        });
        return;
      }
      if (scenario === "child-error") {
        writeOpenAiResponsesSse(response, [
          {
            type: "response.failed",
            response: {
              id: "resp_failed_" + requests,
              status: "failed",
              error: {
                code: "fixture_terminal_error",
                message: "intentional child provider failure",
              },
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "CHILD_LINKED_TYPING_DONE",
        messageId: "msg_" + requests,
        responseId: "resp_" + requests,
      });
      return;
    }
    if (linkedScenario) {
      if (parentStep === 0) {
        parentStep++;
        respondTool("sessions_spawn", {
          taskName: "typing_child",
          task: "CHILD_LINKED_TYPING_TASK: execute the instructed quiet task and return the agreed completion token",
          label: "typing linked child",
          context: "isolated",
          runTimeoutSeconds: scenario === "child" ? 240 : 240,
        });
        return;
      }
      if (parentStep === 1) {
        parentStep++;
        respondTool("typing_fixture_wait", {
          label: "parent",
          durationMs: scenario === "child" ? 130000 : scenario === "child-yield" ? 15000 : 2000,
        });
        return;
      }
      if (parentStep === 2) {
        parentStep++;
        respondTool("sessions_yield", {});
        return;
      }
      throw new Error("unexpected parent request phase " + parentStep);
    }

    writeOpenAiResponsesText(response, {
      text: "DISCORD_TYPING_FINAL_OK_" + modelNonce,
      messageId: "msg_" + requests,
      responseId: "resp_" + requests,
    });
  }
  await listenLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Responses fixture listener missing address");
  }
  return {
    port: address.port,
    url: "http://127.0.0.1:" + address.port,
    get requests() {
      return requests;
    },
    get authorization() {
      return authorization;
    },
    get paths() {
      return paths;
    },
    get routeEvidence() {
      return routeEvidence;
    },
    reset: () => {
      requests = 0;
      parentStep = 0;
      childStep = 0;
      successorStep = 0;
      approvalStep = 0;
      approvalParentStep = 0;
      paths.length = 0;
      routeEvidence.length = 0;
    },
    close: () => closeServer(server),
  };
}

const assertFixtureWebSocketTarget = createFixtureWebSocketGuard(
  allowedLoopbackPorts,
  blockedWebSocketTargets,
  websocketTargets,
);
