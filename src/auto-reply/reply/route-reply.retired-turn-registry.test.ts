import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareWorkspacePluginRegistries } from "../../agents/prepared-model-runtime.inbound-registry.js";
import { retainPreparedPluginRegistry } from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "../../agents/prepared-model-runtime.resources.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { activatePluginRegistry } from "../../plugins/loader-shared.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
  writePluginMetadata,
} from "../../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { isPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryRuntime } from "../../plugins/registry-runtime-binding.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createPluginRegistryOwner } from "../../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { routeReply } from "./route-reply.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const queueState = installDeliveryQueueTmpDirHooks();
const channelId = "borrowed-channel";
const freshId = "prepared-only";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

async function setupRetiredTurnRegistry(cleanup: AsyncDisposableStack) {
  const root = tempDirs.make("openclaw-route-reply-retired-turn-");
  const bundledDir = path.join(root, "bundled");
  const workspaceDir = path.join(root, "workspace");
  const sent: string[] = [];
  Reflect.set(globalThis, Symbol.for("openclaw.test.routeReplySent"), sent);
  const channel = writePlugin({
    id: channelId,
    dir: path.join(bundledDir, channelId),
    filename: "index.cjs",
    registration: `api.registerChannel({ plugin: {
        id: "borrowed-channel",
        meta: { id: "borrowed-channel", label: "Borrowed", selectionLabel: "Borrowed",
          docsPath: "/channels/fixture", blurb: "Borrowed channel fixture" },
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
        outbound: { deliveryMode: "direct",
          async sendText({ text }) {
            globalThis[Symbol.for("openclaw.test.routeReplySent")].push(text);
            return { channel: "borrowed-channel", messageId: "fixture-message" };
          } },
      } });`,
  });
  writePluginMetadata({ dir: channel.dir, id: channelId, channels: [channelId] });
  writePlugin({
    id: freshId,
    dir: path.join(bundledDir, freshId),
    filename: "index.cjs",
    registration: "",
  });
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", queueState.tmpDir());
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  const config: OpenClawConfig = {
    agents: { defaults: { model: "fixture/gateway" } },
    plugins: {
      allow: [channelId, freshId],
      entries: { [channelId]: { enabled: true }, [freshId]: { enabled: true } },
      slots: { memory: "none" },
    },
  };
  setRuntimeConfigSnapshot(config);
  const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
  const gatewayRegistry = loadOpenClawPlugins({
    config,
    workspaceDir,
    manifestRegistry: metadata.manifestRegistry,
    discovery: metadata.discovery,
    preferBuiltPluginArtifacts: true,
    runtimeOptions: { allowGatewaySubagentBinding: true },
    onlyPluginIds: [channelId],
    activate: false,
    runtimeSideEffects: true,
    cache: false,
  });
  const runtime = expectDefined(getPluginRegistryRuntime(gatewayRegistry), "Gateway runtime");
  bindGatewayContextResolver(runtime, () => undefined);
  activatePluginRegistry(gatewayRegistry, null, "gateway-bindable", workspaceDir);
  const gateway = createPluginRegistryOwner(gatewayRegistry, workspaceDir);
  cleanup.defer(async () => {
    await gateway.close();
  });
  const buildResources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
  // A turn admitted by the Gateway borrows the Gateway's channel instance.
  const turnRegistry: PluginRegistry = await withPluginRuntimeRegistryScope(
    gateway.registry,
    async () => {
      const prepared = await prepareWorkspacePluginRegistries(
        { config, workspaceDir, agentDir: workspaceDir, allowGatewaySubagentBinding: true },
        metadata,
        (loaded) => buildResources.retainRegistry(loaded),
        undefined,
        true,
        undefined,
        () => [],
        [channelId, freshId],
        buildResources.load.bind(buildResources),
      );
      return expectDefined(prepared.runtimePluginRegistry, "prepared turn registry");
    },
  );
  // A secrets or config reload releases the turn's generation before it routes its reply.
  await buildResources[Symbol.asyncDispose]();
  expect(isPluginRegistryRetired(turnRegistry)).toBe(true);
  return { config, gateway, turnRegistry, sent };
}

it("routes a retired turn's reply through its admitting Gateway", async () => {
  await using cleanup = new AsyncDisposableStack();
  const { config, turnRegistry, sent } = await setupRetiredTurnRegistry(cleanup);

  const result = await withPluginRuntimeRegistryScope(turnRegistry, () =>
    routeReply({
      payload: { text: "background job finished" },
      channel: channelId,
      to: "fixture-room",
      cfg: config,
      replyKind: "final",
      mirror: false,
    }),
  );

  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ ok: true, delivered: true, messageId: "fixture-message" });
  expect(sent).toEqual(["background job finished"]);
});

it("rejects without sending when the admitting Gateway is gone", async () => {
  await using cleanup = new AsyncDisposableStack();
  const { config, gateway, turnRegistry, sent } = await setupRetiredTurnRegistry(cleanup);
  await gateway.close();

  const result = await withPluginRuntimeRegistryScope(turnRegistry, () =>
    routeReply({
      payload: { text: "background job finished" },
      channel: channelId,
      to: "fixture-room",
      cfg: config,
      replyKind: "final",
      mirror: false,
    }),
  );

  expect(result).toMatchObject({ ok: false, delivered: false });
  expect(isPlatformMessageNotDispatchedError(result.cause)).toBe(true);
  expect(sent).toEqual([]);
});
