import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import type {
  MemoryCorpusSupplement,
  MemoryCorpusSupplementRegistration,
  MemoryFlushPlan,
  MemoryPluginCapability,
  MemoryPluginCapabilityRegistration,
  MemoryPluginDreamingPhaseStatus,
  MemoryPluginDreamingProvider,
  MemoryPluginDreamingStatus,
  MemoryPluginPublicArtifact,
  MemoryPluginRuntime,
  MemoryPromptPreparationRegistration,
  MemoryPromptSectionBuilder,
  MemoryPromptSectionParams,
  MemoryPromptSectionPreparer,
  MemoryPromptSupplementRegistration,
  PreparedMemoryPromptSection,
} from "./registry-contribution-types.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getPluginRegistryForContext,
  getPluginRegistrationContext,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";

const log = createSubsystemLogger("plugins/memory-state");

export type {
  MemoryCorpusSearchResult,
  MemoryCorpusSupplement,
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginDreamingPhaseStatus,
  MemoryPluginDreamingProvider,
  MemoryPluginDreamingStatus,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
  MemoryPromptSectionParams,
  PreparedMemoryPromptSection,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";

export function resolveMemoryCapabilityRegistration(
  registrations: readonly MemoryPluginCapabilityRegistration[],
): MemoryPluginCapabilityRegistration | undefined {
  let effective: MemoryPluginCapabilityRegistration | undefined;
  for (const registration of registrations) {
    const existing = effective;
    if (!existing) {
      effective = registration;
      continue;
    }
    const existingOwnsSlot = existing.memorySlotSelected === true;
    const registrationOwnsSlot = registration.memorySlotSelected === true;
    if (existingOwnsSlot !== registrationOwnsSlot) {
      // A dreaming sidecar contributes consolidation fields, but the selected
      // plugin keeps every field it declares regardless of registration order.
      const owner = existingOwnsSlot ? existing : registration;
      const contributor = existingOwnsSlot ? registration : existing;
      effective = {
        pluginId: owner.pluginId,
        capability: {
          ...contributor.capability,
          ...owner.capability,
        },
        memorySlotSelected: true,
      };
      continue;
    }
    // A later call that only adds providers (public artifacts, dreaming status)
    // layers over the earlier runtime instead of replacing it.
    const preserveExisting =
      Boolean(registration.capability.publicArtifacts || registration.capability.dreaming) &&
      !registration.capability.promptBuilder &&
      !registration.capability.flushPlanResolver &&
      !registration.capability.runtime;
    effective = {
      pluginId: registration.pluginId,
      capability: {
        ...(preserveExisting ? existing.capability : {}),
        ...registration.capability,
      },
      memorySlotSelected: registration.memorySlotSelected,
    };
  }
  return effective;
}

// Cleanup reads must not recreate the process registry after its owner has cleared it.
const getMemoryCapability = () =>
  resolveMemoryCapabilityRegistration(getPluginRegistryForContext()?.memoryCapabilities ?? []);

const preparedMemoryPromptSections = new WeakSet<PreparedMemoryPromptSection>();
const activePreparedMemoryPromptSection = new AsyncLocalStorage<PreparedMemoryPromptSection>();

export function registerMemoryCorpusSupplement(
  requestedPluginId: string,
  supplement: MemoryCorpusSupplement,
): void {
  const pluginId = resolveDirectPluginRegistrationOwner(requestedPluginId) ?? requestedPluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryCorpusSupplements = registry.memoryCorpusSupplements
    .filter((registration) => registration.pluginId !== pluginId)
    .concat({ pluginId, supplement: wrapCurrentPluginInstance(supplement) });
}

export function registerMemoryCapability(
  requestedPluginId: string,
  capability: MemoryPluginCapability,
): void {
  const registrar = getPluginRegistrationContext()?.registerMemoryCapability;
  if (registrar) {
    registrar(capability);
    return;
  }
  const pluginId = resolveDirectPluginRegistrationOwner(requestedPluginId) ?? requestedPluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryCapabilities.push({ pluginId, capability: wrapCurrentPluginInstance(capability) });
}

export function getMemoryCapabilityRegistration(): MemoryPluginCapabilityRegistration | undefined {
  const capability = getMemoryCapability();
  return capability
    ? {
        pluginId: capability.pluginId,
        capability: { ...capability.capability },
      }
    : undefined;
}

export function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[] {
  return [...requireActivePluginRegistry().memoryCorpusSupplements];
}

function adoptEligibleRuntimeMemoryRegistrations<T extends { pluginId: string }>(
  target: T[],
  runtime: readonly T[],
  canAdopt: (pluginId: string) => boolean,
): T[] {
  const pluginIds = new Set(target.map((registration) => registration.pluginId));
  let adopted: T[] | undefined;
  for (const registration of runtime) {
    if (pluginIds.has(registration.pluginId) || !canAdopt(registration.pluginId)) {
      continue;
    }
    (adopted ??= [...target]).push(registration);
    pluginIds.add(registration.pluginId);
  }
  return adopted ?? target;
}

/**
 * Discovery scopes cannot safely rerun full memory plugin setup.
 * Reuse exact root sidecars only while activation and source ownership still match.
 */
export function adoptRuntimeMemoryRegistrations(
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
  config: OpenClawConfig,
): PluginRegistry {
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  const canAdopt = (pluginId: string) => {
    const targetOwner = targetRegistry.plugins.find((plugin) => plugin.id === pluginId);
    const runtimeOwner = runtimeRegistry.plugins.find((plugin) => plugin.id === pluginId);
    if (
      runtimeOwner?.status !== "loaded" ||
      !resolveEffectivePluginActivationState({
        id: runtimeOwner.id,
        origin: runtimeOwner.origin,
        config: normalizedConfig,
        rootConfig: config,
        enabledByDefault: runtimeOwner.activationSource === "default",
      }).enabled ||
      (targetOwner &&
        (targetOwner.status !== "loaded" || targetOwner.source !== runtimeOwner.source))
    ) {
      return false;
    }
    return true;
  };
  const memoryCorpusSupplements = adoptEligibleRuntimeMemoryRegistrations(
    targetRegistry.memoryCorpusSupplements,
    runtimeRegistry.memoryCorpusSupplements,
    canAdopt,
  );
  const memoryPromptPreparations = adoptEligibleRuntimeMemoryRegistrations(
    targetRegistry.memoryPromptPreparations,
    runtimeRegistry.memoryPromptPreparations,
    canAdopt,
  );
  const memoryPromptSupplements = adoptEligibleRuntimeMemoryRegistrations(
    targetRegistry.memoryPromptSupplements,
    runtimeRegistry.memoryPromptSupplements,
    canAdopt,
  );
  return memoryCorpusSupplements === targetRegistry.memoryCorpusSupplements &&
    memoryPromptPreparations === targetRegistry.memoryPromptPreparations &&
    memoryPromptSupplements === targetRegistry.memoryPromptSupplements
    ? targetRegistry
    : {
        ...targetRegistry,
        memoryCorpusSupplements,
        memoryPromptPreparations,
        memoryPromptSupplements,
      };
}
export function registerMemoryPromptSupplement(
  requestedPluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  const pluginId = resolveDirectPluginRegistrationOwner(requestedPluginId) ?? requestedPluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryPromptSupplements = registry.memoryPromptSupplements
    .filter((registration) => registration.pluginId !== pluginId)
    .concat({ pluginId, builder: wrapCurrentPluginInstance(builder) });
}

export function registerMemoryPromptPreparation(
  requestedPluginId: string,
  prepare: MemoryPromptSectionPreparer,
): void {
  const pluginId = resolveDirectPluginRegistrationOwner(requestedPluginId) ?? requestedPluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryPromptPreparations = registry.memoryPromptPreparations
    .filter((registration) => registration.pluginId !== pluginId)
    .concat({ pluginId, prepare: wrapCurrentPluginInstance(prepare) });
}

function buildSynchronousMemoryPromptSection(params: MemoryPromptSectionParams): {
  primary: string[];
  supplements: Array<{ pluginId: string; lines: string[] }>;
} {
  const registry = requireActivePluginRegistry();
  const primary = filterStringEntries(
    resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.capability.promptBuilder?.(
      params,
    ) ?? [],
  );
  const supplements = registry.memoryPromptSupplements
    // Keep supplement order stable even if plugin registration order changes.
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
    .map((registration) => ({
      pluginId: registration.pluginId,
      lines: filterStringEntries(registration.builder(params)),
    }));
  return { primary, supplements };
}

function cloneMemoryPromptSectionParams(
  params: MemoryPromptSectionParams,
): MemoryPromptSectionParams {
  return {
    availableTools: new Set(params.availableTools),
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  };
}

function snapshotMemoryPromptContext(
  params: MemoryPromptSectionParams,
): PreparedMemoryPromptSection["context"] {
  return Object.freeze({
    availableTools: Object.freeze([...params.availableTools].toSorted()),
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed === true,
  });
}

function preparedMemoryPromptContextMatches(
  prepared: PreparedMemoryPromptSection,
  params: MemoryPromptSectionParams,
): boolean {
  // The snapshot comes from a Set, so equal size and membership ignore insertion order.
  return (
    prepared.context.citationsMode === params.citationsMode &&
    prepared.context.agentId === params.agentId &&
    prepared.context.agentSessionKey === params.agentSessionKey &&
    prepared.context.sandboxed === (params.sandboxed === true) &&
    prepared.context.availableTools.length === params.availableTools.size &&
    prepared.context.availableTools.every((tool) => params.availableTools.has(tool))
  );
}

/** Prepare one immutable memory prompt snapshot for a run. */
export async function prepareMemoryPromptSection(
  params: MemoryPromptSectionParams,
): Promise<PreparedMemoryPromptSection> {
  const runParams = cloneMemoryPromptSectionParams(params);
  const context = snapshotMemoryPromptContext(runParams);
  const synchronous = buildSynchronousMemoryPromptSection(
    cloneMemoryPromptSectionParams(runParams),
  );
  const preparationRegistrations = [...requireActivePluginRegistry().memoryPromptPreparations];
  const preparedSupplements = await Promise.all(
    preparationRegistrations.map(async (registration) => ({
      pluginId: registration.pluginId,
      lines: filterStringEntries(
        await registration.prepare(cloneMemoryPromptSectionParams(runParams)),
      ),
    })),
  );
  const lines = Object.freeze([
    ...synchronous.primary,
    ...[...synchronous.supplements, ...preparedSupplements]
      .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
      .flatMap((registration) => registration.lines),
  ]);
  const prepared = Object.freeze({
    context,
    lines,
  });
  preparedMemoryPromptSections.add(prepared);
  return prepared;
}

/** Keep async preparation run-scoped while a context engine assembles synchronously. */
export async function runWithPreparedMemoryPromptSection<T>(
  params: MemoryPromptSectionParams,
  run: () => Promise<T>,
): Promise<T> {
  const prepared = await prepareMemoryPromptSection(params);
  return activePreparedMemoryPromptSection.run(prepared, run);
}

export function getActivePreparedMemoryPromptSection(): PreparedMemoryPromptSection | undefined {
  return activePreparedMemoryPromptSection.getStore();
}

export function buildMemoryPromptSection(
  params: MemoryPromptSectionParams,
  prepared?: PreparedMemoryPromptSection,
): string[] {
  if (prepared) {
    // Run-scoped prompt state must never cross agent/session/tool boundaries.
    if (
      !preparedMemoryPromptSections.has(prepared) ||
      !preparedMemoryPromptContextMatches(prepared, params)
    ) {
      throw new Error("prepared memory prompt section does not match the current run");
    }
    return [...prepared.lines];
  }
  const synchronous = buildSynchronousMemoryPromptSection(params);
  return [...synchronous.primary, ...synchronous.supplements.flatMap((entry) => entry.lines)];
}

export function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[] {
  return [...requireActivePluginRegistry().memoryPromptSupplements];
}
export function listMemoryPromptPreparations(): MemoryPromptPreparationRegistration[] {
  return [...requireActivePluginRegistry().memoryPromptPreparations];
}
export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
  contextWindowTokens?: number;
}): MemoryFlushPlan | null {
  return getMemoryCapability()?.capability.flushPlanResolver?.(params) ?? null;
}
export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return getMemoryCapability()?.capability.runtime;
}

let standaloneMemoryManagerActive = false;

// Standalone managers are intentionally absent from the active plugin registry.
export function setStandaloneMemoryManagerActive(active: boolean): void {
  standaloneMemoryManagerActive = active;
}

export function hasMemoryRuntime(): boolean {
  return standaloneMemoryManagerActive || getMemoryRuntime() !== undefined;
}

function cloneMemoryPublicArtifact(
  artifact: MemoryPluginPublicArtifact,
): MemoryPluginPublicArtifact {
  const agentIds = Array.isArray(artifact.agentIds) ? artifact.agentIds : [];
  return {
    ...artifact,
    agentIds: [...agentIds],
  };
}

// The sort below dereferences these fields, so a plugin-supplied artifact
// missing any of them would crash every status/bridge consumer.
function isValidMemoryPublicArtifact(
  artifact: MemoryPluginPublicArtifact | null | undefined,
): artifact is MemoryPluginPublicArtifact {
  return (
    typeof artifact?.kind === "string" &&
    typeof artifact.workspaceDir === "string" &&
    typeof artifact.relativePath === "string" &&
    typeof artifact.absolutePath === "string" &&
    typeof artifact.contentType === "string"
  );
}

export async function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const capability = getMemoryCapability();
  const pluginId = capability?.pluginId;
  const listed = (await capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
  if (!Array.isArray(listed)) {
    log.warn(`ignoring public memory artifacts from plugin "${pluginId}": not an array`);
    return [];
  }
  const artifacts = listed.filter(isValidMemoryPublicArtifact);
  if (artifacts.length < listed.length) {
    log.warn(
      `ignoring ${listed.length - artifacts.length} malformed public memory artifact(s) from plugin "${pluginId}": artifacts must include string kind, workspaceDir, relativePath, absolutePath, and contentType`,
    );
  }
  return artifacts
    .map(cloneMemoryPublicArtifact)
    .toSorted(
      (left, right) =>
        left.workspaceDir.localeCompare(right.workspaceDir) ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.kind.localeCompare(right.kind) ||
        left.contentType.localeCompare(right.contentType) ||
        left.agentIds.join("\0").localeCompare(right.agentIds.join("\0")) ||
        left.absolutePath.localeCompare(right.absolutePath),
    );
}

/**
 * Reported timestamps and counters go straight into date formatting and page
 * text, where `NaN`, `Infinity` or a negative count would render as garbage,
 * so only finite numbers (non-negative for counters) pass.
 */
function isOptionalFiniteNumber(value: unknown, options: { min?: number } = {}): boolean {
  if (value === undefined) {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= (options.min ?? -Infinity);
}

function isValidDreamingPhaseStatus(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  const phase = asOptionalRecord(value);
  if (!phase) {
    return false;
  }
  return (
    (phase.enabled === undefined || typeof phase.enabled === "boolean") &&
    (phase.cron === undefined || typeof phase.cron === "string") &&
    (phase.scheduled === undefined || typeof phase.scheduled === "boolean") &&
    isOptionalFiniteNumber(phase.lastRunAtMs) &&
    isOptionalFiniteNumber(phase.nextRunAtMs)
  );
}

function copyDreamingPhase(
  phase: MemoryPluginDreamingPhaseStatus | undefined,
): MemoryPluginDreamingPhaseStatus | undefined {
  if (phase === undefined) {
    return undefined;
  }
  return {
    ...(phase.enabled === undefined ? {} : { enabled: phase.enabled }),
    ...(phase.cron === undefined ? {} : { cron: phase.cron }),
    ...(phase.scheduled === undefined ? {} : { scheduled: phase.scheduled }),
    ...(phase.lastRunAtMs === undefined ? {} : { lastRunAtMs: phase.lastRunAtMs }),
    ...(phase.nextRunAtMs === undefined ? {} : { nextRunAtMs: phase.nextRunAtMs }),
  };
}

/**
 * Copies only the documented fields of a validated report. The provider's own
 * object never reaches the RPC response: extra keys, getters and a `toJSON`
 * would otherwise ship to the Control UI unchecked.
 */
function copyDreamingStatus(report: MemoryPluginDreamingStatus): MemoryPluginDreamingStatus {
  const phases = report.phases;
  const stats = report.stats;
  const light = copyDreamingPhase(phases?.light);
  const deep = copyDreamingPhase(phases?.deep);
  const rem = copyDreamingPhase(phases?.rem);
  return {
    ...(report.enabled === undefined ? {} : { enabled: report.enabled }),
    ...(report.timezone === undefined ? {} : { timezone: report.timezone }),
    ...(phases === undefined
      ? {}
      : {
          phases: {
            ...(light === undefined ? {} : { light }),
            ...(deep === undefined ? {} : { deep }),
            ...(rem === undefined ? {} : { rem }),
          },
        }),
    ...(stats === undefined
      ? {}
      : {
          stats: {
            ...(stats.shortTermCount === undefined ? {} : { shortTermCount: stats.shortTermCount }),
            ...(stats.promotedTotal === undefined ? {} : { promotedTotal: stats.promotedTotal }),
            ...(stats.promotedToday === undefined ? {} : { promotedToday: stats.promotedToday }),
            ...(stats.lastPromotedAt === undefined ? {} : { lastPromotedAt: stats.lastPromotedAt }),
          },
        }),
  };
}

const DREAMING_STATS_NUMBER_KEYS = ["shortTermCount", "promotedTotal", "promotedToday"] as const;

/**
 * The top-level report fields the host overlays without further checks. A
 * string `enabled` would reach the page and slip past its boolean-only owner
 * lock, so a report is rejected as a whole when any of them has the wrong type.
 */
function isValidDreamingStatusTop(report: MemoryPluginDreamingStatus): boolean {
  if (report.enabled !== undefined && typeof report.enabled !== "boolean") {
    return false;
  }
  if (report.timezone !== undefined && typeof report.timezone !== "string") {
    return false;
  }
  if (report.stats === undefined) {
    return true;
  }
  const stats = asOptionalRecord(report.stats);
  if (!stats) {
    return false;
  }
  for (const key of DREAMING_STATS_NUMBER_KEYS) {
    if (!isOptionalFiniteNumber(stats[key], { min: 0 })) {
      return false;
    }
  }
  return stats.lastPromotedAt === undefined || typeof stats.lastPromotedAt === "string";
}

/**
 * Asks the memory slot owner how its own dreaming is scheduled and how far
 * consolidation has got. Returns `null` when no provider is registered, when it
 * declines, or when it misbehaves — callers then keep memory-core's resolution,
 * so a third-party provider can never blank out the page.
 */
export async function resolveActiveMemoryDreamingStatus(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemoryPluginDreamingStatus | null> {
  const capability = getMemoryCapability();
  const provider: MemoryPluginDreamingProvider | undefined = capability?.capability.dreaming;
  if (!provider) {
    return null;
  }
  const pluginId = capability?.pluginId;
  // The checks read the provider's object, whose getters may throw like the
  // call itself, so the whole inspection sits inside the guard.
  try {
    const reported = await provider.getStatus(params);
    if (reported === undefined || reported === null) {
      return null;
    }
    // Any report at all locks the page's host switch, so an array — which is
    // `typeof "object"` too — must not count as one.
    if (!asOptionalRecord(reported)) {
      log.warn(`ignoring dreaming status from plugin "${pluginId}": not an object`);
      return null;
    }
    const phases = reported.phases;
    if (
      phases !== undefined &&
      (!asOptionalRecord(phases) ||
        !isValidDreamingPhaseStatus(phases.light) ||
        !isValidDreamingPhaseStatus(phases.deep) ||
        !isValidDreamingPhaseStatus(phases.rem))
    ) {
      log.warn(`ignoring dreaming status from plugin "${pluginId}": malformed phases`);
      return null;
    }
    if (!isValidDreamingStatusTop(reported)) {
      log.warn(
        `ignoring dreaming status from plugin "${pluginId}": malformed enablement, timezone or stats`,
      );
      return null;
    }
    return copyDreamingStatus(reported);
  } catch (err) {
    log.warn(`ignoring dreaming status from plugin "${pluginId}": ${String(err)}`);
    return null;
  }
}

export function clearMemoryPluginState(): void {
  const registry = requireActivePluginRegistry();
  registry.memoryCapabilities = [];
  registry.memoryCorpusSupplements = [];
  registry.memoryPromptPreparations = [];
  registry.memoryPromptSupplements = [];
}
