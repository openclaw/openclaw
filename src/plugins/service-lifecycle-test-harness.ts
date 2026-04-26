import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";
import type {
  OpenClawPluginService,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  PluginHookName,
  PluginHookRegistration,
  PluginLogger,
} from "./types.js";

export type PluginServiceLifecycleTestHarnessOptions = {
  pluginId?: string;
  pluginName?: string;
  config?: OpenClawConfig;
  stateDir?: string;
  workspaceDir?: string;
  logger?: PluginLogger;
};

export type PluginServiceLifecycleTestHarness = {
  registry: PluginRegistry;
  stateDir: string;
  workspaceDir?: string;
  registerService: (service: OpenClawPluginService) => void;
  registerHook: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookRegistration<K>["handler"],
    hookOptions?: { priority?: number },
  ) => void;
  startServices: () => Promise<PluginServicesHandle>;
  stopServices: () => Promise<void>;
  runGatewayStart: (
    event?: Partial<PluginHookGatewayStartEvent>,
    context?: Partial<PluginHookGatewayContext>,
  ) => Promise<void>;
  runGatewayStop: (
    event?: PluginHookGatewayStopEvent,
    context?: Partial<PluginHookGatewayContext>,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
};

function createNoopPluginLogger(): PluginLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function addTestPluginRecord(params: {
  registry: PluginRegistry;
  pluginId: string;
  pluginName: string;
  source: string;
  rootDir: string;
}): void {
  params.registry.plugins.push({
    id: params.pluginId,
    name: params.pluginName,
    source: params.source,
    rootDir: params.rootDir,
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  });
}

export async function createPluginServiceLifecycleTestHarness(
  options: PluginServiceLifecycleTestHarnessOptions = {},
): Promise<PluginServiceLifecycleTestHarness> {
  const createdStateDir = options.stateDir
    ? undefined
    : await mkdtemp(path.join(tmpdir(), "openclaw-plugin-service-"));
  const stateDir = options.stateDir ?? createdStateDir!;
  const registry = createEmptyPluginRegistry();
  const pluginId = options.pluginId ?? "test-plugin";
  const pluginName = options.pluginName ?? "Test Plugin";
  const source = "plugin-service-lifecycle-test-harness";
  const rootDir = stateDir;
  const config = options.config ?? ({} as OpenClawConfig);
  let servicesHandle: PluginServicesHandle | undefined;

  addTestPluginRecord({ registry, pluginId, pluginName, source, rootDir });
  const pluginRecord = registry.plugins[0];

  const registerService = (service: OpenClawPluginService): void => {
    const id = service.id.trim();
    if (!id) {
      throw new Error("registerService: service.id must not be empty");
    }
    if (registry.services.some((entry) => entry.service.id === id)) {
      throw new Error(`registerService: a service with id "${id}" is already registered`);
    }
    pluginRecord.services.push(id);
    registry.services.push({
      pluginId,
      pluginName,
      service,
      source,
      origin: "workspace",
      rootDir,
    });
  };

  const registerHook = <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookRegistration<K>["handler"],
    hookOptions?: { priority?: number },
  ): void => {
    pluginRecord.hookNames.push(hookName);
    pluginRecord.hookCount += 1;
    registry.typedHooks.push({
      pluginId,
      hookName,
      handler,
      priority: hookOptions?.priority ?? 0,
      source,
    });
  };

  const stopServices = async (): Promise<void> => {
    const handle = servicesHandle;
    servicesHandle = undefined;
    await handle?.stop();
  };

  const getHookRunner = () =>
    createHookRunner(registry, { logger: options.logger ?? createNoopPluginLogger() });

  return {
    registry,
    stateDir,
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    registerService,
    registerHook,
    startServices: async () => {
      await stopServices();
      servicesHandle = await startPluginServices({
        registry,
        config,
        workspaceDir: options.workspaceDir,
        stateDir,
      });
      return servicesHandle;
    },
    stopServices,
    runGatewayStart: async (event, context) => {
      await getHookRunner().runGatewayStart(
        { port: event?.port ?? 0 },
        { config, workspaceDir: options.workspaceDir, ...context },
      );
    },
    runGatewayStop: async (event, context) => {
      await getHookRunner().runGatewayStop(event ?? {}, {
        config,
        workspaceDir: options.workspaceDir,
        ...context,
      });
    },
    cleanup: async () => {
      await stopServices();
      if (createdStateDir) {
        await rm(createdStateDir, { recursive: true, force: true });
      }
    },
  };
}
