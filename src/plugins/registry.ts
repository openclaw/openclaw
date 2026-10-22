import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasInvalidLifecycleStartTimestamp } from "../infra/agent-event-lifecycle.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import { resolveCapabilityProviderRegistration } from "./capability-catalog.js";
import { resolvePromptInjectionAllowed } from "./hook-policy-decisions.js";
import {
  clearPluginRunContext,
  getPluginRunContext,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import {
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "./host-hook-scheduled-turns.js";
import { isPluginJsonValue } from "./host-hooks.js";
import { getPluginCache, retirePluginCacheInstance } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { getPluginRuntimeEntrySource } from "./plugin-runtime-artifact-binding.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  isPluginRecordActive,
} from "./registry-lifecycle.js";
import { createPluginRegistrars, type PluginRegistrars } from "./registry-registrars.js";
import { createPluginRuntimeResolver } from "./registry-runtime.js";
import {
  createPluginRegistryState,
  resolvePluginRegistrationCapabilities,
  type PluginTypedHookPolicy,
} from "./registry-state.js";
import type {
  PluginRecord as RegistryPluginRecord,
  PluginRegistryParams,
} from "./registry-types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "./types.js";

export type {
  PluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistry,
} from "./registry-types.js";
export { createEmptyPluginRegistry } from "./registry-empty.js";

type BoundRegistrars = {
  [K in keyof PluginRegistrars]: PluginRegistrars[K] extends (
    record: RegistryPluginRecord,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result
    : never;
};

// Registration exposes these async operations without loading session storage or delivery.
const loadAttachments = createLazyRuntimeModule(() => import("./host-hook-attachments.js"));
const loadHookState = createLazyRuntimeModule(() => import("./host-hook-state.js"));
const loadSteering = createLazyRuntimeModule(() => import("./host-hook-steering.js"));

const HOST_OWNED_AGENT_EVENT_STREAMS = new Set<string>([
  "lifecycle",
  "tool",
  "assistant",
  "error",
  "item",
  "plan",
  "approval",
  "command_output",
  "patch",
  "compaction",
  "thinking",
  "model",
]);

function resolvePluginPath(input: string, rootDir: string | undefined): string {
  const trimmed = input.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return resolveUserPath(input);
  }
  return rootDir ? path.resolve(rootDir, trimmed) : resolveUserPath(input);
}

function clonePluginRecord(record: RegistryPluginRecord): RegistryPluginRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as RegistryPluginRecord;
}

/**
 * Compose the registry state, domain registrars, scoped runtime, and plugin API.
 * Domain modules own validation and mutation; this function owns lifecycle wiring only.
 */
export function createPluginRegistry(registryOptions: PluginRegistryParams) {
  const state = createPluginRegistryState(registryOptions);
  const cache = getPluginCache();
  const registrars = createPluginRegistrars(state);
  const runtimeResolver = createPluginRuntimeResolver(state);
  const { registry, registryParams, getHostCronService, pushDiagnostic } = state;
  const { resolvePluginRuntime, resolveRegisteredChannelRuntime } = runtimeResolver;

  const registrationRecordSnapshots = new WeakMap<RegistryPluginRecord, RegistryPluginRecord>();
  const createApi = (
    record: RegistryPluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
      registrationMode?: PluginRegistrationMode;
    },
  ): OpenClawPluginApi => {
    registrationRecordSnapshots.set(record, clonePluginRecord(record));
    const registrationMode = params.registrationMode ?? "full";
    const registrationCapabilities = resolvePluginRegistrationCapabilities(registrationMode);
    const shouldCommitWorkflowSideEffect = () =>
      capturePluginLifecycleAuthority(getPluginRecordRegistry(registry, record), record, {
        registration: true,
      })?.() === true;
    // Run-local scratch state bridges admitted hooks and services without
    // granting a scoped registration process-global workflow side effects.
    const shouldAccessRunContext = () =>
      capturePluginLifecycleAuthority(getPluginRecordRegistry(registry, record), record, {
        registration: true,
        admittedRuntime: true,
      })?.() === true;
    const boundRegistrars = Object.fromEntries(
      Object.entries(registrars).map(([name, register]) => [
        name,
        (...args: unknown[]) => Reflect.apply(register, undefined, [record, ...args]),
      ]),
    );
    // SAFETY: Every registrar retains its key and signature with only its leading record bound.
    const { registerChannel, ...bound } = boundRegistrars as BoundRegistrars;
    const bindCapabilityRegistrar =
      <T extends { id: string }>(register: (provider: T) => unknown) =>
      (entry: Parameters<typeof resolveCapabilityProviderRegistration<T>>[0]): void => {
        register(
          resolveCapabilityProviderRegistration(
            entry,
            registryParams.resolveCapabilityCatalogContext,
          ),
        );
      };
    const api = buildPluginApi({
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      runtimeSource: getPluginRuntimeEntrySource(record),
      rootDir: record.rootDir,
      registrationMode,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime:
        registrationMode === "cli-metadata"
          ? createUnavailableRuntime(registrationMode, record.id)
          : resolvePluginRuntime(record, registrationMode),
      logger: {
        info: registryParams.logger.info,
        warn: registryParams.logger.warn,
        error: registryParams.logger.error,
        debug: registryParams.logger.debug,
      },
      resolvePath: (input: string) =>
        resolvePluginPath(input, registrationMode === "cli-metadata" ? undefined : record.rootDir),
      handlers: {
        ...(registrationCapabilities.capabilityHandlers
          ? {
              ...bound,
              registerHook: (events, handler, opts) =>
                bound.registerHook(events, handler, opts, params.config, params.pluginConfig),
              registerSpeechProvider: bindCapabilityRegistrar(bound.registerSpeechProvider),
              registerRealtimeTranscriptionProvider: bindCapabilityRegistrar(
                bound.registerRealtimeTranscriptionProvider,
              ),
              registerRealtimeVoiceProvider: bindCapabilityRegistrar(
                bound.registerRealtimeVoiceProvider,
              ),
              registerNodeInvokePolicy: (policy) =>
                bound.registerNodeInvokePolicy(policy, params.pluginConfig),
              onConversationBindingResolved: bound.registerConversationBindingResolvedHandler,
              registerContextEngine: (id, factory) =>
                bound.registerContextEngine(id, factory, registrationMode),
              registerAgentToolResultMiddleware: (handler, options) => {
                bound.registerAgentToolResultMiddleware(handler, options, params.hookPolicy);
              },
              enqueueNextTurnInjection: async (injection) => {
                if (params.hookPolicy?.allowPromptInjection === false) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: `next-turn injection blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
                  });
                  return {
                    enqueued: false,
                    id: "",
                    sessionKey: injection.sessionKey,
                  };
                }
                const { enqueuePluginNextTurnInjection } = await loadHookState();
                if (
                  registryParams.activateGlobalSideEffects === false ||
                  !shouldCommitWorkflowSideEffect()
                ) {
                  return { enqueued: false, id: "", sessionKey: injection.sessionKey };
                }
                return enqueuePluginNextTurnInjection({
                  // SAFETY: The host helper reads the SDK's readonly view of the same config data.
                  cfg: registryParams.runtime.config.current() as OpenClawConfig,
                  pluginId: record.id,
                  pluginName: record.name,
                  injection,
                });
              },
              steerActiveRun: async (input) => {
                if (!resolvePromptInjectionAllowed(params.hookPolicy)) {
                  return {
                    steered: false,
                    reason: `blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
                  };
                }
                if (registryParams.activateGlobalSideEffects === false) {
                  return { steered: false, reason: "global side effects disabled" };
                }
                const isCurrent = capturePluginLifecycleAuthority(
                  getPluginRecordRegistry(registry, record),
                  record,
                  { registration: true },
                );
                const assertCurrent = () => {
                  if (!isCurrent?.()) {
                    throw new Error(`Plugin "${record.id}" is no longer loaded`);
                  }
                };
                assertCurrent();
                const { steerPluginActiveRun } = await loadSteering();
                assertCurrent();
                return steerPluginActiveRun({
                  // SAFETY: The host helper reads the SDK's readonly view of the same config data.
                  cfg: registryParams.runtime.config.current() as OpenClawConfig,
                  pluginId: record.id,
                  pluginName: record.name,
                  input,
                  assertCurrent,
                });
              },
              emitAgentEvent: (event) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { emitted: false, reason: "global side effects disabled" };
                }
                if (!shouldCommitWorkflowSideEffect()) {
                  return { emitted: false, reason: "plugin is not loaded" };
                }
                const runId = normalizeOptionalString(event.runId);
                const sessionKey = normalizeOptionalString(event.sessionKey);
                const stream = normalizeOptionalString(event.stream);
                if (!runId || !stream) {
                  return { emitted: false, reason: "runId and stream are required" };
                }
                if (!isPluginJsonValue(event.data)) {
                  return { emitted: false, reason: "event data must be JSON-compatible" };
                }
                if (record.origin !== "bundled" && HOST_OWNED_AGENT_EVENT_STREAMS.has(stream)) {
                  return {
                    emitted: false,
                    reason: `stream ${stream} is reserved for bundled plugins`,
                  };
                }
                if (
                  record.origin !== "bundled" &&
                  stream !== record.id &&
                  !stream.startsWith(`${record.id}.`)
                ) {
                  return {
                    emitted: false,
                    reason: `stream ${stream} must be scoped to plugin ${record.id}`,
                  };
                }
                if (hasInvalidLifecycleStartTimestamp(stream, event.data)) {
                  return {
                    emitted: false,
                    reason: "lifecycle start requires a finite startedAt timestamp",
                  };
                }
                emitAgentEvent({
                  runId,
                  stream,
                  ...(sessionKey ? { sessionKey } : {}),
                  data: {
                    ...(event.data && typeof event.data === "object" && !Array.isArray(event.data)
                      ? event.data
                      : { value: event.data }),
                    pluginId: record.id,
                    ...(record.name ? { pluginName: record.name } : {}),
                  },
                });
                return { emitted: true, stream };
              },
              setRunContext: (patch) =>
                shouldAccessRunContext()
                  ? setPluginRunContext({ pluginId: record.id, patch })
                  : false,
              getRunContext: (get) =>
                shouldAccessRunContext()
                  ? getPluginRunContext({ pluginId: record.id, get })
                  : undefined,
              clearRunContext: (paramsLocal) => {
                if (!shouldAccessRunContext()) {
                  return;
                }
                clearPluginRunContext({
                  pluginId: record.id,
                  runId: paramsLocal.runId,
                  namespace: paramsLocal.namespace,
                });
              },
              sendSessionAttachment: async (attachment) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { ok: false, error: "global side effects disabled" };
                }
                try {
                  const { sendPluginSessionAttachment } = await loadAttachments();
                  if (!isPluginRecordActive(registry, record)) {
                    return { ok: false, error: "plugin is not loaded" };
                  }
                  const runtimeConfig =
                    // SAFETY: Attachment setup reads the published config without mutating it.
                    (registryParams.runtime.config?.current?.() as OpenClawConfig | undefined) ??
                    params.config;
                  return await sendPluginSessionAttachment({
                    ...attachment,
                    config: runtimeConfig,
                    origin: record.origin,
                  });
                } catch (error) {
                  return {
                    ok: false,
                    error: `attachment delivery setup failed: ${formatErrorMessage(error)}`,
                  };
                }
              },
              scheduleSessionTurn: async (schedule) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return undefined;
                }
                await Promise.resolve();
                return schedulePluginSessionTurn({
                  pluginId: record.id,
                  pluginName: record.name,
                  origin: record.origin,
                  schedule,
                  cron: getHostCronService(),
                  shouldCommit: shouldCommitWorkflowSideEffect,
                  ownerRegistry: getPluginRecordRegistry(registry, record),
                });
              },
              unscheduleSessionTurnsByTag: async (request) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { removed: 0, failed: 0 };
                }
                await Promise.resolve();
                if (!shouldCommitWorkflowSideEffect()) {
                  return { removed: 0, failed: 0 };
                }
                return unschedulePluginSessionTurnsByTag({
                  pluginId: record.id,
                  origin: record.origin,
                  cron: getHostCronService(),
                  request,
                });
              },
              on: (hookName, handler, opts) =>
                registrars.registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
            }
          : {}),
        ...(registrationCapabilities.setupRuntimeHandlers
          ? {
              registerHttpRoute: bound.registerHttpRoute,
              registerGatewayMethod: bound.registerGatewayMethod,
              registerSessionCatalog: bound.registerSessionCatalog,
            }
          : {}),
        // Allow setup-only/setup-runtime paths to surface parse-time CLI metadata
        // without opting into the wider full-registration surface.
        registerCli: bound.registerCli,
        ...(registrationMode === "cli-metadata"
          ? {}
          : {
              registerChannel: (registration) =>
                registerChannel(
                  registration,
                  registrationMode,
                  registrationCapabilities.runtimeChannel
                    ? () => resolveRegisteredChannelRuntime(record)
                    : undefined,
                ),
            }),
      },
    });
    return instrumentPluginInstanceApi(
      api,
      getPluginInstance(record) ??
        new PluginInstance(record.id, { record, registry: state.registry }),
    );
  };

  const rollbackPluginGlobalSideEffects = (pluginId: string, record: RegistryPluginRecord) => {
    runtimeResolver.revokePluginRuntimeRecord(pluginId, record);
    projectPluginContributions(state.registry, record);
    const recordSnapshot = registrationRecordSnapshots.get(record);
    if (recordSnapshot) {
      Object.keys(record).forEach((key) => Reflect.deleteProperty(record, key));
      Object.assign(record, recordSnapshot);
      registrationRecordSnapshots.delete(record);
    }
    // Failed evaluation can own resources before the record is published.
    const instance = getPluginInstance(record);
    const inspection = getPluginRegistryInspectionResources(state.registry);
    const retire =
      instance && !instance.disposing
        ? () => retirePluginCacheInstance(instance, cache)
        : undefined;
    if (inspection) {
      // Invalid async registration may still use this inspection's sibling resources.
      inspection.rollback(pluginId, retire, instance);
    } else if (retire) {
      void retire().catch((error: unknown) => {
        state.pushDiagnostic({
          level: "warn",
          pluginId,
          source: record.source,
          message: `plugin cleanup failed after registration rollback: ${formatErrorMessage(error)}`,
        });
      });
    }
  };

  return {
    ...registrars,
    registry: state.registry,
    createApi,
    rollbackPluginGlobalSideEffects,
    pushDiagnostic: state.pushDiagnostic,
  };
}
