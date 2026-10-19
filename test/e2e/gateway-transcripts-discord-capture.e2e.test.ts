import "../../src/test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, inject, it, vi } from "vitest";
import type {
  TranscriptsGetResult,
  TranscriptsListResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { createTestPluginServiceScheduler } from "../../src/plugin-sdk/plugin-test-api.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../src/test-utils/env.js";
import { withIsolatedTestHome } from "../../test/test-env.js";
import { readRequestText, closeHttpServer } from "../helpers/gateway-integration-fixtures.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

type TranscriptCapturePorts = { gateway: number; provider: number };

declare module "vitest" {
  export interface ProvidedContext {
    transcriptCapturePorts?: TranscriptCapturePorts;
  }
}

type CaptureArguments = { action: "start" | "stop" | "summarize" } & Record<string, unknown>;
type ScriptedCall = {
  callId: string;
  agentId: "main" | "agent-b";
  args: CaptureArguments;
  output?: string;
};
type DiscordCaptureTestApi = typeof import("../../extensions/discord/test-api.js");
type CaptureModule = Awaited<ReturnType<DiscordCaptureTestApi["loadDiscordGatewayCaptureFixture"]>>;
type DiscordCaptureFixture = ReturnType<CaptureModule["createDiscordGatewayCaptureFixture"]>;

function sendResponse(response: ServerResponse, item: Record<string, unknown>) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function sendMessage(response: ServerResponse, id: string, text: string) {
  sendResponse(response, {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
}

afterEach(async () => {
  // Minimal Gateway startup omits cleanup for watchers created by real agent turns.
  const { closeSkillsWatchers } = await import("../../src/skills/runtime/refresh.js");
  await closeSkillsWatchers(true);
});

it("fences late Discord STT and preserves the admitted owner's history after a room route changes", async () => {
  const ports = inject("transcriptCapturePorts");
  if (
    ports !== undefined &&
    (ports.gateway === ports.provider ||
      [ports.gateway, ports.provider].some(
        (port) => !Number.isInteger(port) || port <= 0 || port > 65535,
      ))
  ) {
    throw new Error("transcriptCapturePorts requires distinct integer gateway and provider ports");
  }
  const enabledFlags = [
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  ];
  // Minimal mode skips login without removing channel config from the runtime.
  const clearedFlags = [
    "OPENCLAW_BUILD_PRIVATE_QA",
    "OPENCLAW_QA_FORCE_RUNTIME",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
  ];
  const env = captureEnv(["NODE_ENV", ...enabledFlags, ...clearedFlags, "OPENCLAW_GATEWAY_PORT"]);
  const isolated = withIsolatedTestHome({ mode: "hermetic" });
  const stateDir = path.join(isolated.tempHome, ".openclaw");
  const workspace = path.join(isolated.tempHome, "workspace");
  const configPath = path.join(stateDir, "openclaw.json");
  let gateway:
    | Awaited<
        ReturnType<typeof import("../../src/gateway/test-helpers.e2e.js").startGatewayWithClient>
      >
    | undefined;
  let fixture: DiscordCaptureFixture | undefined;
  let fixtureScheduler: ReturnType<typeof createTestPluginServiceScheduler> | undefined;
  let releaseFixtureRegistry: (() => Promise<void>) | undefined;
  let routedService:
    | ReturnType<
        typeof import("../../src/transcripts/auto-start.js").createTranscriptsAutoStartService
      >
    | undefined;
  let cleanupRuntime: (() => Promise<void>) | undefined;
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const calls: ScriptedCall[] = [];
  const deniedConnections: string[] = [];
  let providerPort: number | undefined;
  deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
  const selectedGatewayPort = () => ports?.gateway ?? Number(process.env.OPENCLAW_GATEWAY_PORT);
  // The native method must retain each caller's socket, supplied by Reflect.apply below.
  // oxlint-disable-next-line typescript/unbound-method
  const originalConnect = Socket.prototype.connect;
  // Reject unexpected Node HTTP(S), WS and fetch destinations. This guard does
  // not isolate native transports or child processes; the manual OS fence does.
  const socketFence = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = asOptionalRecord(normalized[0]);
    const host = options?.host ?? normalized[1];
    const port = Number(options?.port ?? normalized[0]);
    // startGatewayWithClient publishes its allocated port before opening its WS client.
    const gatewayPort = selectedGatewayPort();
    if (
      host !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port <= 0 ||
      (port !== providerPort && port !== gatewayPort)
    ) {
      const reason = `unexpected socket destination ${String(host)}:${port}`;
      deniedConnections.push(reason);
      throw new Error(reason);
    }
    return Reflect.apply(originalConnect, this, args);
  });
  let currentCall: ScriptedCall | undefined;
  let awaitingOutput = false;
  let summaryTranscript: string | undefined;
  let summaryRequests = 0;
  const providerServer = createServer((request, response) => {
    void (async () => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe("Bearer test");
      const body = asOptionalRecord(JSON.parse(await readRequestText(request)));
      expect(body?.model).toBe("capture-proof");
      expect(body?.stream).toBe(true);
      requests.push(body!);
      // Unscripted conversation calls fail visibly, including recording-only scan regressions.
      expect(currentCall, "unexpected model request outside an admitted tool turn").toBeDefined();
      const call = currentCall!;
      if (
        awaitingOutput &&
        (call.args.action === "stop" || call.args.action === "summarize") &&
        !body?.tools
      ) {
        expect(call.agentId).toBe("main");
        summaryRequests++;
        expect(summaryTranscript).toBeDefined();
        const summaryInput = JSON.stringify(body);
        expect(summaryInput).toContain("Write concise meeting notes in the transcript's language.");
        expect(summaryInput).toContain(summaryTranscript!);
        sendMessage(
          response,
          "msg_capture_summary",
          JSON.stringify({
            overview: "The participant supplied a synthetic capture note.",
            decisions: [],
            actionItems: [],
            risks: [],
          }),
        );
        return;
      }
      if (!awaitingOutput) {
        expect(body?.tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "transcripts" })]),
        );
        awaitingOutput = true;
        sendResponse(response, {
          type: "function_call",
          id: `fc_${call.callId}`,
          call_id: call.callId,
          name: "transcripts",
          arguments: JSON.stringify(call.args),
          status: "completed",
        });
        return;
      }
      const input = body?.input;
      expect(Array.isArray(input)).toBe(true);
      const inputItems = (input as unknown[]).map(asOptionalRecord);
      const result = inputItems.findLast(
        (item) => item?.type === "function_call_output" && item.call_id === call.callId,
      );
      expect(typeof result?.output).toBe("string");
      call.output = result!.output as string;
      currentCall = undefined;
      awaitingOutput = false;
      sendMessage(response, `msg_${call.callId}`, `Completed ${call.args.action}.`);
    })().catch((error: unknown) => {
      errors.push(error);
      response.writeHead(500).end("Unexpected scripted capture request");
    });
  });
  try {
    // Production settings retain the source host's SDK graph for fixture and plugin loads.
    // VITEST and the explicit minimal flag retain test lifecycle isolation.
    setTestEnvValue("NODE_ENV", "production");
    for (const key of clearedFlags) {
      deleteTestEnvValue(key);
    }
    for (const key of enabledFlags) {
      setTestEnvValue(key, "1");
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(stateDir, { recursive: true }),
    ]);
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(ports?.provider ?? 0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1" ||
      (ports !== undefined && address.port !== ports.provider)
    ) {
      throw new Error("Unexpected transcript fixture provider address");
    }
    providerPort = address.port;
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "capture-proof",
    );
    const testApiId = resolveRelativeBundledPluginPublicModuleId({
      fromModuleUrl: import.meta.url,
      pluginId: "discord",
      artifactBasename: "test-api.js",
    });
    const testApiPath = fileURLToPath(new URL(testApiId, import.meta.url));
    const discordPluginDir = path.dirname(testApiPath);
    const [{ createPluginModuleLoader }, { resolveOpenClawDevSourceRoot }] = await Promise.all([
      import("../../src/plugins/loader-module-runtime.js"),
      import("../../src/plugins/dev-source-root.js"),
    ]);
    const devSourceRoot = resolveOpenClawDevSourceRoot();
    // Use the runtime entry's loader graph so the fixture manager and model-selected
    // provider share Discord's lifecycle state. Vitest owns only the injected test utilities.
    const loadDiscordModule = createPluginModuleLoader({
      devSourceRoot,
      loaderFilename: path.join(discordPluginDir, "index.ts"),
    });
    const { loadDiscordGatewayCaptureFixture } = loadDiscordModule(
      testApiPath,
    ) as DiscordCaptureTestApi;
    const { createDiscordGatewayCaptureFixture, captureTarget, capturedText, lateText } =
      await loadDiscordGatewayCaptureFixture();
    summaryTranscript = capturedText;
    const { startGatewayWithClient } = await import("../../src/gateway/test-helpers.e2e.js");
    const { createPluginRuntime } = await import("../../src/plugins/runtime/index.js");
    const { createPluginRegistry } = await import("../../src/plugins/registry.js");
    const { createPluginRecord } = await import("../../src/plugins/loader-records.js");
    const { getPluginInstance, getPluginValueInstance } =
      await import("../../src/plugins/plugin-instance-scope.js");
    const { loadPluginMetadataSnapshot } =
      await import("../../src/plugins/plugin-metadata-snapshot.js");
    const { bindPluginRuntimeArtifactSelection } =
      await import("../../src/plugins/plugin-runtime-artifact-binding.js");
    const { resolvePluginRuntimeArtifactSelection, resolvePluginRuntimeExecutionArtifact } =
      await import("../../src/plugins/plugin-runtime-artifact-selection.js");
    const { PluginRegistryInspectionResources } =
      await import("../../src/plugins/registry-inspection-resources.js");
    const { retireInspectionInstances } =
      await import("../../src/plugins/registry-inspection.test-support.js");
    const {
      getActivePluginRegistry,
      setActivePluginRegistry,
      captureActivePluginRegistrySnapshot,
      restoreActivePluginRegistrySnapshot,
    } = await import("../../src/plugins/runtime.js");
    const { getPluginRuntimeLoadContext } =
      await import("../../src/plugins/runtime/load-context.js");
    const { withPluginRuntimeRegistryScope } =
      await import("../../src/plugins/runtime/gateway-request-scope.js");
    const { refreshPreparedModelRuntimeSnapshots, loadPublishedGatewayReplyDispatchRuntime } =
      await import("../../src/agents/prepared-model-runtime.js");
    const { resetPreparedModelRuntimeSnapshotsForTest } =
      await import("../../src/agents/prepared-model-runtime.test-support.js");
    const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
      await import("../../src/config/config.js");
    const { resetConfigOverrides } = await import("../../src/config/runtime-overrides.js");
    const { clearSessionStoreCacheForTest } =
      await import("../../src/config/sessions/store-writer-state.js");
    const { drainSessionStoreWriterQueuesForTest } =
      await import("../../src/config/sessions/store-writer-state.test-support.js");
    const { closeOpenClawStateDatabaseByPathAsync } =
      await import("../../src/state/openclaw-state-db-cache.js");
    const { activeSessions } = await import("../../src/transcripts/capture-startup.js");
    const { resolveSourceProvider } = await import("../../src/transcripts/capture.js");
    const { createTranscriptsAutoStartService } =
      await import("../../src/transcripts/auto-start.js");
    const { TranscriptsStore } = await import("../../src/transcripts/store.js");
    const ownedCaptures = () =>
      [...activeSessions.values()].filter(
        (capture) => capture.session.source.accountId === captureTarget.accountId,
      );
    const previousRegistry = captureActivePluginRegistrySnapshot();
    cleanupRuntime = () =>
      runQaGatewayFixture(
        async () => {
          for (const capture of ownedCaptures()) {
            await capture.finalization?.released;
          }
          expect(ownedCaptures()).toEqual([]);
        },
        drainSessionStoreWriterQueuesForTest,
        async () => {
          clearSessionStoreCacheForTest();
          await resetPreparedModelRuntimeSnapshotsForTest();
          await closeOpenClawStateDatabaseByPathAsync(
            path.join(stateDir, "state", "openclaw.sqlite"),
          );
          resetConfigOverrides();
          clearRuntimeConfigSnapshot();
          clearConfigCache();
          restoreActivePluginRegistrySnapshot(previousRegistry);
        },
      );
    resetConfigOverrides();
    const token = "synthetic-gateway-capture-token";
    const cfg: OpenClawConfig = {
      skills: { load: { watch: false } },
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace },
          "agent-b": { workspace },
        },
        defaults: {
          workspace,
          skipBootstrap: true,
          systemAgent: { agentId: "main" },
          sessionStore: { agentId: "main" },
          heartbeat: { every: "0m" },
          model: { primary: provider.modelRef, fallbacks: [] },
          models: {
            [provider.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      talk: { agentId: "main" },
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: captureTarget.accountId,
            peer: { kind: "channel", id: captureTarget.channelId },
          },
        },
        { agentId: "main", match: { channel: "discord", accountId: "*" } },
      ],
      channels: {
        discord: {
          // Minimal startup skips login; the health monitor must not start it later.
          healthMonitor: { enabled: false },
          accounts: {
            [captureTarget.accountId]: {
              token: "synthetic-discord-token",
              voice: { enabled: true, mode: "stt-tts" },
            },
          },
        },
      },
      gateway: { auth: { mode: "token", token } },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
      plugins: {
        allow: ["discord"],
        entries: { discord: { enabled: true } },
        // Keep source proof on the same explicit plugin entry even when dist exists.
        load: { paths: [discordPluginDir] },
        slots: { memory: "none" },
      },
      tools: { allow: ["transcripts"], codeMode: false, toolSearch: false },
      transcripts: { enabled: true },
    };
    const runtime = createPluginRuntime();
    const registration = createPluginRegistry({ runtime, logger: console });
    const registryResources = new PluginRegistryInspectionResources(retireInspectionInstances);
    registryResources.attach(registration.registry);
    releaseFixtureRegistry = () => registryResources.release();
    const registrationMetadata = loadPluginMetadataSnapshot({
      config: cfg,
      workspaceDir: workspace,
    });
    const manifest = registrationMetadata.manifestRegistry.plugins.find(
      (plugin) => plugin.id === "discord",
    );
    if (!manifest) {
      throw new Error("Discord fixture manifest was not selected");
    }
    const runtimeEntry = resolvePluginRuntimeExecutionArtifact(
      resolvePluginRuntimeArtifactSelection({
        ...manifest,
        entryKind: "runtime",
        preferBuiltPluginArtifacts: true,
      }),
    );
    expect(runtimeEntry).toEqual({
      source: path.join(discordPluginDir, "index.ts"),
      rootDir: discordPluginDir,
    });
    const record = createPluginRecord({
      id: "discord",
      ...runtimeEntry,
      origin: manifest.origin,
      enabled: true,
      configSchema: true,
    });
    // Match the loader's artifact identity so publication retains this registration
    // instead of loading another Discord provider behind the edge spies.
    const artifactBinding = bindPluginRuntimeArtifactSelection(record, {
      ...manifest,
      runtimeEntry,
      preferBuiltPluginArtifacts: true,
    });
    registration.registry.plugins.push(record);
    const api = registration.createApi(record, { config: cfg });
    const pluginInstance = getPluginInstance(record)!;
    const scheduler = pluginInstance.run(() => createTestPluginServiceScheduler());
    fixtureScheduler = scheduler;
    fixture = pluginInstance.run(() =>
      createDiscordGatewayCaptureFixture({ cfg, scheduler, test: { expect, vi } }),
    );
    // Match loader registration: runtime slots belong to the invoking plugin instance.
    pluginInstance.run(() => fixture!.register(api));
    expect(registration.registry.diagnostics).toEqual([]);
    expect(record.transcriptSourceProviderIds).toEqual(["discord-voice"]);
    expect(
      getPluginValueInstance(registration.registry.transcriptSourceProviders[0]!.provider),
    ).toBe(pluginInstance);
    artifactBinding.runtimeRegistrationComplete = true;
    // Minimal startup retains this real registration; it skips monitor login/sidecars only.
    // This does not prove full plugin discovery or Discord monitor startup.
    setActivePluginRegistry(registration.registry);
    gateway = await startGatewayWithClient({
      port: ports?.gateway,
      cfg,
      configPath,
      token,
      scopes: ["operator.admin"],
    });
    await gateway.server.startupSettled;
    expect(getRuntimeConfig().channels?.discord).toMatchObject(cfg.channels!.discord!);
    const metadata = getPluginRuntimeLoadContext(registration.registry)?.metadataSnapshot;
    // Minimal startup skips the model-publication sidecar. Publish through its
    // production owner, retaining the real fixture registration for both agents.
    setActivePluginRegistry(
      registration.registry,
      undefined,
      "gateway-bindable",
      metadata!.workspaceDir,
    );
    await withPluginRuntimeRegistryScope(registration.registry, () =>
      refreshPreparedModelRuntimeSnapshots(getRuntimeConfig, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        defaultWorkspaceDir: workspace,
        pluginMetadataSnapshot: metadata,
      }),
    );
    for (const agentId of ["main", "agent-b"]) {
      const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId });
      const inboundProvider = published?.inboundPluginRegistry.transcriptSourceProviders.find(
        (entry) => entry.provider.id === "discord-voice",
      )?.provider;
      expect(inboundProvider).toBe(registration.registry.transcriptSourceProviders[0]?.provider);
      expect(getPluginValueInstance(inboundProvider!)).toBe(pluginInstance);
      const selectedRegistry = published?.pluginGeneration.pluginRegistry;
      const selectedProvider = selectedRegistry?.transcriptSourceProviders.find(
        (entry) => entry.provider.id === "discord-voice",
      )?.provider;
      expect(selectedProvider, agentId).toBe(inboundProvider);
    }
    pluginInstance.run(() => fixture!.bindPublishedRuntime());
    expect(gateway.port).not.toBe(providerPort);
    expect(getActivePluginRegistry()).toBe(registration.registry);
    const client = gateway.client;
    const sessionKeys = {
      main: `agent:main:capture-proof-${randomUUID()}`,
      "agent-b": `agent:agent-b:capture-proof-${randomUUID()}`,
    };
    const sessionId = `capture-${randomUUID()}`;
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
    const runTurn = async (args: CaptureArguments, agentId: "main" | "agent-b" = "main") => {
      const call: ScriptedCall = { callId: `call_capture_${calls.length}`, agentId, args };
      calls.push(call);
      currentCall = call;
      const accepted = await client.request<{ runId: string; status: string }>("agent", {
        sessionKey: sessionKeys[agentId],
        message: `Perform the synthetic capture ${args.action} operation.`,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(accepted).toMatchObject({ status: "accepted", runId: expect.any(String) });
      const completed = await client.request<{ status: string }>("agent.wait", {
        runId: accepted.runId,
        timeoutMs: 30_000,
      });
      expect(completed.status, `${agentId}:${args.action}`).toBe("ok");
      expect(errors).toEqual([]);
      expect(currentCall).toBeUndefined();
      return call.output!;
    };
    const start = await runTurn({
      action: "start",
      providerId: "discord-voice",
      ...captureTarget,
      sessionId,
    });
    expect(start).toContain(`Transcripts started: ${sessionId}`);
    const selector = /^Selector: (.+)$/m.exec(start)?.[1];
    expect(selector).toBeDefined();
    const speaker = await pluginInstance.run(() => fixture!.expectReady());
    const admitted = await store.readSession(selector!);
    const source = { providerId: "discord-voice", ...captureTarget };
    expect(admitted).toMatchObject({ sessionId, metadata: { agentId: "main" } });
    expect(admitted?.source).toEqual({ ...source, agentId: "main" });
    const listed = await client.request<TranscriptsListResult>("transcripts.list", {});
    const session = { selector, sessionId };
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        ...session,
        agentId: "main",
        source: expect.objectContaining(source),
        activeSubscription: true,
      }),
    ]);
    expect(requests).toHaveLength(2);

    await fixture.recordAfterTurn();
    const readCapture = () =>
      client.request<TranscriptsGetResult>("transcripts.get", {
        selector,
        includeUtterances: true,
      });
    const captured = await readCapture();
    expect(captured).toMatchObject({
      session: { ...session, utteranceCount: 1, activeSubscription: true },
      utterances: [
        {
          sequence: 0,
          text: capturedText,
          final: true,
          speakerId: speaker.speakerId,
          speakerLabel: speaker.speakerLabel,
        },
      ],
    });
    expect(requests).toHaveLength(2);
    expect(errors).toEqual([]);

    await pluginInstance.run(() => fixture!.beginLateDelivery());
    const stop = await runTurn({ action: "stop", selector });
    expect(stop).toContain(`Transcripts stopped: ${sessionId}`);
    expect(stop).toContain(`Selector: ${selector}`);
    await fixture.finishLateDelivery();
    const stopped = await readCapture();
    expect(stopped).toMatchObject({
      session: {
        ...session,
        agentId: "main",
        utteranceCount: 1,
        activeSubscription: false,
        stoppedAt: expect.any(String),
      },
      summary: { utteranceCount: 1, source: "model" },
    });
    expect(stopped.utterances).toEqual(captured.utterances);
    expect(JSON.stringify(stopped)).not.toContain(lateText);
    const stoppedSession = await store.readSession(selector!);
    expect(stoppedSession).toEqual({ ...admitted, stoppedAt: stopped.session.stoppedAt });
    const utterances = await store.readUtterancesForSession(stoppedSession!);
    expect(utterances).toEqual([
      expect.objectContaining({
        text: capturedText,
        metadata: {
          channel: "discord",
          guildId: captureTarget.guildId,
          channelId: captureTarget.channelId,
          voiceSessionKey: speaker.voiceSessionKey,
        },
      }),
    ]);
    expect(requests).toHaveLength(5);
    expect(summaryRequests).toBe(1);

    // Rotate the real manager and transport while preserving the scenario's SDK spies.
    const routedConfig: OpenClawConfig = {
      ...cfg,
      bindings: [{ ...cfg.bindings![0]!, agentId: "agent-b" }],
      transcripts: {
        enabled: true,
        autoStart: [{ providerId: "discord-voice", ...captureTarget, whenOccupied: true }],
      },
    };
    await pluginInstance.run(() => fixture!.rotateManager(routedConfig));
    const routedContext: Parameters<typeof createTranscriptsAutoStartService>[0] = {
      stateDir,
      config: routedConfig,
      logger: { warn: vi.fn() },
      caller: { kind: "operator", source: "scheduled" },
    };
    const routedProvider = resolveSourceProvider("discord-voice", routedContext);
    expect(routedProvider).toBe(registration.registry.transcriptSourceProviders[0]?.provider);
    expect(getPluginValueInstance(routedProvider!)).toBe(pluginInstance);
    routedService = createTranscriptsAutoStartService(routedContext);
    await withPluginRuntimeRegistryScope(registration.registry, () => routedService!.start())
      .settled;
    await expect
      .poll(() => ownedCaptures()[0])
      .toMatchObject({
        phase: "active",
        session: { metadata: { agentId: "agent-b" } },
      });
    const replacement = ownedCaptures()[0]!;
    expect(replacement.session.sessionId).not.toBe(sessionId);
    expect(await store.readSession(selector!)).toEqual(stoppedSession);
    expect(await store.readUtterancesForSession(stoppedSession!)).toEqual(utterances);
    const savedSummary = await store.readSummary(stoppedSession!);
    const providerStop = vi.spyOn(replacement, "stopProvider");
    const sessionWrite = vi.spyOn(TranscriptsStore.prototype, "writeSession");
    const summaryWrite = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
    try {
      for (const action of ["stop", "summarize"] as const) {
        expect(await runTurn({ action, selector }, "agent-b")).toContain("session not found");
      }
      expect(providerStop).not.toHaveBeenCalled();
      expect(sessionWrite).not.toHaveBeenCalled();
      expect(summaryWrite).not.toHaveBeenCalled();
      expect(await store.readSession(selector!)).toEqual(stoppedSession);
      expect(await store.readSummary(stoppedSession!)).toEqual(savedSummary);
      expect(await store.readUtterancesForSession(stoppedSession!)).toEqual(utterances);
      expect(await runTurn({ action: "summarize", selector })).toContain(
        `Transcripts summarized: ${sessionId}`,
      );
      expect(summaryWrite).toHaveBeenCalledTimes(1);
      expect(providerStop).not.toHaveBeenCalled();
      expect(activeSessions.get(replacement.session.sessionId)).toBe(replacement);
    } finally {
      providerStop.mockRestore();
      sessionWrite.mockRestore();
      summaryWrite.mockRestore();
    }
    await routedService.stop();
    expect(requests).toHaveLength(12);
    expect(summaryRequests).toBe(2);
    expect(errors).toEqual([]);
    expect(deniedConnections).toEqual([]);
  } finally {
    // Keep the actual runtime and edge spies alive until sources, streams and Gateway settle.
    await runQaGatewayFixture(
      async () => {
        await routedService?.stop();
      },
      () => {
        fixtureScheduler?.beginClose();
      },
      () => fixture?.close(),
      () => fixtureScheduler?.stop(),
      () => gateway?.client.stopAndWait(),
      () => gateway?.server.close({ reason: "synthetic transcript capture cleanup" }),
      () => closeHttpServer(providerServer),
      () => cleanupRuntime?.(),
      () => releaseFixtureRegistry?.(),
      () => {
        fixture?.restore();
        socketFence.mockRestore();
        isolated.cleanup();
        env.restore();
      },
    );
  }
});
