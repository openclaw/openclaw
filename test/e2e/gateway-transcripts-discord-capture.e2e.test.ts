import "../../src/test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, inject, it, vi } from "vitest";
import type { TranscriptsGetResult } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { createTestPluginServiceScheduler } from "../../src/plugin-sdk/plugin-test-api.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../src/test-utils/env.js";
import { withIsolatedTestHome } from "../../test/test-env.js";
import { readRequestText, closeHttpServer } from "../helpers/gateway-integration-fixtures.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

type TranscriptCapturePorts = { gateway: number; provider: number };

declare module "vitest" {
  export interface ProvidedContext {
    transcriptCapturePorts?: TranscriptCapturePorts;
  }
}

type CaptureArguments = { action: "start" | "stop" } & Record<string, unknown>;
type ScriptedCall = {
  callId: string;
  args: CaptureArguments;
  output?: string;
};
type DiscordCaptureTestApi = typeof import("../../extensions/discord/test-api.js");
type CaptureModule = Awaited<ReturnType<DiscordCaptureTestApi["loadDiscordGatewayCaptureFixture"]>>;
type DiscordCaptureFixture = ReturnType<CaptureModule["createDiscordGatewayCaptureFixture"]>;

function sendResponse(response: ServerResponse, item: Record<string, unknown>) {
  writeOpenAiResponsesSse(response, [
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
  ]);
}

function sendMessage(response: ServerResponse, id: string, text: string) {
  writeOpenAiResponsesText(response, { text, messageId: id, responseId: `resp_${randomUUID()}` });
}

afterEach(async () => {
  // Minimal Gateway startup omits cleanup for watchers created by real agent turns.
  const { closeSkillsWatchers } = await import("../../src/skills/runtime/refresh.js");
  await closeSkillsWatchers(true);
});

it("fences late Discord STT through the model-selected plugin instance", async () => {
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
  let cleanupRuntime: (() => Promise<void>) | undefined;
  let requests = 0;
  const errors: unknown[] = [];
  const deniedConnections: string[] = [];
  let providerPort: number | undefined;
  deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
  const selectedGatewayPort = () => ports?.gateway ?? Number(process.env.OPENCLAW_GATEWAY_PORT);
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
  const providerServer = createServer((request, response) => {
    void (async () => {
      const body = asOptionalRecord(JSON.parse(await readRequestText(request)));
      requests++;
      // Unscripted conversation calls fail visibly, including recording-only scan regressions.
      expect(currentCall, "unexpected model request outside an admitted tool turn").toBeDefined();
      const call = currentCall!;
      if (awaitingOutput && call.args.action === "stop" && !body?.tools) {
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
    const { startGatewayWithClient } = await import("../../src/gateway/test-helpers.e2e.js");
    const { createPluginRuntime } = await import("../../src/plugins/runtime/index.js");
    const { createPluginRegistry } = await import("../../src/plugins/registry.js");
    const { createPluginRecord } = await import("../../src/plugins/loader-records.js");
    const { getPluginInstance } = await import("../../src/plugins/plugin-instance-scope.js");
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
    const runtimeState = await import("../../src/plugins/runtime.js");
    const loadContext = await import("../../src/plugins/runtime/load-context.js");
    const runtimeScope = await import("../../src/plugins/runtime/gateway-request-scope.js");
    const preparedRuntime = await import("../../src/agents/prepared-model-runtime.js");
    const preparedTest = await import("../../src/agents/prepared-model-runtime.test-support.js");
    const configState = await import("../../src/config/config.js");
    const { resetConfigOverrides } = await import("../../src/config/runtime-overrides.js");
    const { clearSessionStoreCacheForTest } =
      await import("../../src/config/sessions/store-writer-state.js");
    const { drainSessionStoreWriterQueuesForTest } =
      await import("../../src/config/sessions/store-writer-state.test-support.js");
    const { closeOpenClawStateDatabaseByPathAsync } =
      await import("../../src/state/openclaw-state-db-cache.js");
    const { activeSessions } = await import("../../src/transcripts/capture-startup.js");
    const ownedCaptures = () =>
      [...activeSessions.values()].filter(
        (capture) => capture.session.source.accountId === captureTarget.accountId,
      );
    const previousRegistry = runtimeState.captureActivePluginRegistrySnapshot();
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
          await preparedTest.resetPreparedModelRuntimeSnapshotsForTest();
          await closeOpenClawStateDatabaseByPathAsync(
            path.join(stateDir, "state", "openclaw.sqlite"),
          );
          resetConfigOverrides();
          configState.clearRuntimeConfigSnapshot();
          configState.clearConfigCache();
          runtimeState.restoreActivePluginRegistrySnapshot(previousRegistry);
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
        },
        defaults: {
          workspace,
          skipBootstrap: true,
          systemAgent: { agentId: "main" },
          sessionStore: { agentId: "main" },
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
    pluginInstance.run(() => fixture!.register(api));
    artifactBinding.runtimeRegistrationComplete = true;
    // Minimal startup retains this real registration; it skips monitor login/sidecars only.
    // This does not prove full plugin discovery or Discord monitor startup.
    runtimeState.setActivePluginRegistry(registration.registry);
    gateway = await startGatewayWithClient({
      port: ports?.gateway,
      cfg,
      configPath,
      token,
      scopes: ["operator.admin"],
    });
    await gateway.server.startupSettled;
    const metadata = loadContext.getPluginRuntimeLoadContext(
      registration.registry,
    )?.metadataSnapshot;
    // Minimal startup skips model publication; use its production owner.
    runtimeState.setActivePluginRegistry(
      registration.registry,
      undefined,
      "gateway-bindable",
      metadata!.workspaceDir,
    );
    await runtimeScope.withPluginRuntimeRegistryScope(registration.registry, () =>
      preparedRuntime.refreshPreparedModelRuntimeSnapshots(configState.getRuntimeConfig, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        defaultWorkspaceDir: workspace,
        pluginMetadataSnapshot: metadata,
      }),
    );
    pluginInstance.run(() => fixture!.bindPublishedRuntime());
    const client = gateway.client;
    const sessionKey = `agent:main:capture-proof-${randomUUID()}`;
    const sessionId = `capture-${randomUUID()}`;
    const runTurn = async (args: CaptureArguments) => {
      const call: ScriptedCall = { callId: `call_capture_${randomUUID()}`, args };
      currentCall = call;
      const accepted = await client.request<{ runId: string; status: string }>("agent", {
        sessionKey,
        message: `Perform the synthetic capture ${args.action} operation.`,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(accepted).toMatchObject({ status: "accepted", runId: expect.any(String) });
      const completed = await client.request<{ status: string }>("agent.wait", {
        runId: accepted.runId,
        timeoutMs: 30_000,
      });
      expect(completed.status, args.action).toBe("ok");
      expect(currentCall).toBeUndefined();
      return call.output!;
    };
    const start = await runTurn({
      action: "start",
      providerId: "discord-voice",
      ...captureTarget,
      sessionId,
    });
    const selector = /^Selector: (.+)$/m.exec(start)?.[1];
    expect(selector).toBeDefined();
    const speaker = await pluginInstance.run(() => fixture!.expectReady());
    const session = { selector, sessionId };
    expect(requests).toBe(2);

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
    expect(requests).toBe(2);

    await pluginInstance.run(() => fixture!.beginLateDelivery());
    await runTurn({ action: "stop", selector });
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
    expect(requests).toBe(5);

    expect(errors).toEqual([]);
    expect(deniedConnections).toEqual([]);
  } finally {
    // Keep the actual runtime and edge spies alive until sources, streams and Gateway settle.
    await runQaGatewayFixture(
      async () => {
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
