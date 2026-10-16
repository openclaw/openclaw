import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StorageProvider } from "../storage/types.js";
import type { AgentExecutorController } from "./agent-executor-controller.types.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
} from "./agent-tool-result-middleware-types.js";
import {
  agentToolResultMiddlewareRegistrationCoversTool,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { resolveCapabilityProviderRegistration } from "./capability-catalog.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type { EmbeddingProviderAdapter } from "./embedding-providers.js";
import type {
  PluginAgentEventSubscriptionRegistration,
  PluginControlUiDescriptor,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionRegistration,
  PluginSessionSchedulerJobRegistration,
  PluginSessionExtensionRegistration,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import { resolvePluginCapabilityCatalogContext } from "./loader-runtime-load.js";
import type { PluginManifestContracts } from "./manifest-types.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import { normalizePluginToolMatcher } from "./tool-hook-matcher.js";
import type {
  AnyAgentTool,
  AgentHarness,
  CliBackendPlugin,
  OpenClawPluginApi,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  TranscriptSourceProvider,
  MigrationProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginCliRootCommandDescriptor,
  OpenClawPluginCliRegistrar,
  PluginTextTransformRegistration,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  UnifiedModelCatalogProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
  WorkerProvider,
} from "./types.js";

type CapturedPluginCliRegistration = {
  register: OpenClawPluginCliRegistrar;
  parentPath: string[];
  commands: string[];
  descriptors: OpenClawPluginCliRootCommandDescriptor[];
};

export type CapturedPluginRegistration = ReturnType<typeof createCapturedPluginRegistration>;

function captureInto<T>(entries: T[]): (entry: T) => void {
  return (entry) => {
    entries.push(entry);
  };
}

function captureCapabilityInto<T extends { id: string }>(entries: T[]) {
  return (entry: Parameters<typeof resolveCapabilityProviderRegistration<T>>[0]) => {
    entries.push(
      resolveCapabilityProviderRegistration(entry, resolvePluginCapabilityCatalogContext),
    );
  };
}

export function createCapturedPluginRegistration(params?: {
  config?: OpenClawConfig;
  contracts?: PluginManifestContracts;
  id?: string;
  name?: string;
  registrationMode?: OpenClawPluginApi["registrationMode"];
  source?: string;
}) {
  const captured = {
    providers: new Array<ProviderPlugin>(),
    agentHarnesses: new Array<AgentHarness>(),
    agentExecutorControllers: new Array<AgentExecutorController>(),
    cliRegistrars: new Array<CapturedPluginCliRegistration>(),
    cliBackends: new Array<CliBackendPlugin>(),
    textTransforms: new Array<PluginTextTransformRegistration>(),
    codexAppServerExtensionFactories: new Array<CodexAppServerExtensionFactory>(),
    agentToolResultMiddlewares: new Array<PluginAgentToolResultMiddlewareRegistration>(),
    embeddingProviders: new Array<EmbeddingProviderAdapter>(),
    speechProviders: new Array<SpeechProviderPlugin>(),
    realtimeTranscriptionProviders: new Array<RealtimeTranscriptionProviderPlugin>(),
    realtimeVoiceProviders: new Array<RealtimeVoiceProviderPlugin>(),
    mediaUnderstandingProviders: new Array<MediaUnderstandingProviderPlugin>(),
    transcriptSourceProviders: new Array<TranscriptSourceProvider>(),
    imageGenerationProviders: new Array<ImageGenerationProviderPlugin>(),
    videoGenerationProviders: new Array<VideoGenerationProviderPlugin>(),
    musicGenerationProviders: new Array<MusicGenerationProviderPlugin>(),
    webFetchProviders: new Array<WebFetchProviderPlugin>(),
    webSearchProviders: new Array<WebSearchProviderPlugin>(),
    workerProviders: new Array<WorkerProvider>(),
    storageProviders: new Array<StorageProvider>(),
    migrationProviders: new Array<MigrationProviderPlugin>(),
    sessionExtensions: new Array<PluginSessionExtensionRegistration>(),
    trustedToolPolicies: new Array<PluginTrustedToolPolicyRegistration>(),
    toolMetadata: new Array<PluginToolMetadataRegistration>(),
    controlUiDescriptors: new Array<PluginControlUiDescriptor>(),
    runtimeLifecycles: new Array<PluginRuntimeLifecycleRegistration>(),
    agentEventSubscriptions: new Array<PluginAgentEventSubscriptionRegistration>(),
    sessionSchedulerJobs: new Array<PluginSessionSchedulerJobRegistration>(),
    sessionActions: new Array<PluginSessionActionRegistration>(),
    tools: new Array<AnyAgentTool>(),
    modelCatalogProviders: new Array<UnifiedModelCatalogProviderPlugin>(),
    sessionCatalogs: new Array<SessionCatalogProvider>(),
  };
  let capturedSessionTurnCount = 0;
  const pluginId = params?.id ?? "captured-plugin-registration";
  const pluginName = params?.name ?? "Captured Plugin Registration";
  const pluginSource = params?.source ?? "captured-plugin-registration";
  const registrationMode = params?.registrationMode ?? "full";
  const noopLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  return {
    ...captured,
    api: buildPluginApi({
      id: pluginId,
      name: pluginName,
      source: pluginSource,
      registrationMode,
      config: params?.config ?? {},
      runtime:
        registrationMode === "cli-metadata" || registrationMode === "setup-only"
          ? createUnavailableRuntime(registrationMode, pluginId)
          : createPluginRuntime(),
      logger: noopLogger,
      resolvePath: (input) => input,
      handlers: {
        registerCli(registrar, opts) {
          const parentPath = normalizeStringEntries(opts?.parentPath ?? []);
          const rootRegistration = parentPath.length === 0;
          const descriptors = (opts?.descriptors ?? [])
            .map((descriptor) => {
              const machineOutput = rootRegistration
                ? (descriptor as OpenClawPluginCliRootCommandDescriptor).machineOutput
                : undefined;
              const normalized: OpenClawPluginCliRootCommandDescriptor = {
                name: descriptor.name.trim(),
                description: descriptor.description.trim(),
                hasSubcommands: descriptor.hasSubcommands,
              };
              if (machineOutput) {
                normalized.machineOutput = machineOutput;
              }
              return normalized;
            })
            .filter((descriptor) => descriptor.name && descriptor.description);
          const commands = normalizeUniqueStringEntries([
            ...(opts?.commands ?? []),
            ...descriptors.map((descriptor) => descriptor.name),
          ]);
          if (commands.length === 0) {
            return;
          }
          captured.cliRegistrars.push({
            register: registrar,
            parentPath,
            commands,
            descriptors,
          });
        },
        registerProvider: captureInto(captured.providers),
        registerModelCatalogProvider: captureInto(captured.modelCatalogProviders),
        registerSessionCatalog: captureInto(captured.sessionCatalogs),
        registerAgentHarness: captureInto(captured.agentHarnesses),
        registerAgentExecutorController: captureInto(captured.agentExecutorControllers),
        registerCodexAppServerExtensionFactory: captureInto(
          captured.codexAppServerExtensionFactories,
        ),
        registerAgentToolResultMiddleware(
          handler: AgentToolResultMiddleware,
          options?: AgentToolResultMiddlewareOptions,
        ) {
          const runtimes = normalizeAgentToolResultMiddlewareRuntimes(
            options,
            params?.contracts?.agentToolResultMiddleware,
          );
          const matcher = normalizePluginToolMatcher(options?.matcher);
          const scopedHandler: AgentToolResultMiddleware = (event, ctx) => {
            if (
              !agentToolResultMiddlewareRegistrationCoversTool(
                registration,
                ctx.runtime,
                event.toolName,
              )
            ) {
              return;
            }
            return handler(event, ctx);
          };
          const registration: PluginAgentToolResultMiddlewareRegistration = {
            pluginId,
            pluginName,
            rawHandler: handler,
            handler: scopedHandler,
            runtimes,
            scopes: [
              {
                runtimes,
                ...(matcher ? { matcher } : {}),
              },
            ],
            source: pluginSource,
          };
          captured.agentToolResultMiddlewares.push(registration);
        },
        registerCliBackend: captureInto(captured.cliBackends),
        registerTextTransforms: captureInto(captured.textTransforms),
        registerEmbeddingProvider: captureInto(captured.embeddingProviders),
        registerSpeechProvider: captureCapabilityInto(captured.speechProviders),
        registerRealtimeTranscriptionProvider: captureCapabilityInto(
          captured.realtimeTranscriptionProviders,
        ),
        registerRealtimeVoiceProvider: captureCapabilityInto(captured.realtimeVoiceProviders),
        registerMediaUnderstandingProvider: captureInto(captured.mediaUnderstandingProviders),
        registerTranscriptSourceProvider: captureInto(captured.transcriptSourceProviders),
        registerImageGenerationProvider: captureInto(captured.imageGenerationProviders),
        registerVideoGenerationProvider: captureInto(captured.videoGenerationProviders),
        registerMusicGenerationProvider: captureInto(captured.musicGenerationProviders),
        registerWebFetchProvider: captureInto(captured.webFetchProviders),
        registerWebSearchProvider: captureInto(captured.webSearchProviders),
        registerWorkerProvider: captureInto(captured.workerProviders),
        registerStorageProvider: captureInto(captured.storageProviders),
        registerMigrationProvider: captureInto(captured.migrationProviders),
        registerSessionExtension: captureInto(captured.sessionExtensions),
        registerTrustedToolPolicy(policy: PluginTrustedToolPolicyRegistration) {
          const matcher = normalizePluginToolMatcher(policy.matcher);
          captured.trustedToolPolicies.push({ ...policy, ...(matcher ? { matcher } : {}) });
        },
        registerToolMetadata: captureInto(captured.toolMetadata),
        registerControlUiDescriptor: captureInto(captured.controlUiDescriptors),
        registerRuntimeLifecycle: captureInto(captured.runtimeLifecycles),
        registerAgentEventSubscription: captureInto(captured.agentEventSubscriptions),
        emitAgentEvent: () => ({ emitted: false, reason: "captured registration" }),
        registerSessionSchedulerJob(job: PluginSessionSchedulerJobRegistration) {
          captured.sessionSchedulerJobs.push(job);
          return {
            id: job.id,
            pluginId,
            sessionKey: job.sessionKey,
            kind: job.kind,
          };
        },
        registerSessionAction: captureInto(captured.sessionActions),
        sendSessionAttachment: async () => ({ ok: false, error: "captured registration" }),
        scheduleSessionTurn: async (schedule) => {
          capturedSessionTurnCount += 1;
          return {
            id: `captured-session-turn-${capturedSessionTurnCount}`,
            pluginId,
            sessionKey: schedule.sessionKey,
            kind: "session-turn",
          };
        },
        unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }),
        registerTool(tool) {
          if (typeof tool !== "function" && !("contextVersion" in tool)) {
            captured.tools.push(tool);
          }
        },
      },
    }),
  };
}

export function capturePluginRegistration(
  params: NonNullable<Parameters<typeof createCapturedPluginRegistration>[0]> & {
    register(api: OpenClawPluginApi): void;
  },
): CapturedPluginRegistration {
  const captured = createCapturedPluginRegistration(params);
  params.register(captured.api);
  return captured;
}
