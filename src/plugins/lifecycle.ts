import type { ConfigReplaceResult } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getPluginRuntimeEntrySource } from "./plugin-runtime-artifact-binding.js";
import { getSharedPluginCodeReloadWarning } from "./plugin-shared-module-loader.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryVersion } from "./runtime.js";

export const getPluginRuntimeGeneration = getActivePluginRegistryVersion;

/** Carries the install persistence owner’s durable-commit fact, including across RPC. */
export class PluginInstallPersistedError extends Error {
  constructor(
    readonly pluginId: string,
    cause: unknown,
  ) {
    super(
      `${formatErrorMessage(cause)}
Plugin "${pluginId}" installation is saved. Fix the reported issue, then run \`openclaw plugins reload ${pluginId}\`.`,
      { cause },
    );
    this.name = "PluginInstallPersistedError";
  }
}

export class PluginRuntimeApplicationError extends Error {
  constructor(
    message: string,
    readonly details: {
      operationId: string;
      generation: number;
      pluginIds: string[];
      phase: "prepare" | "drain" | "activate" | "dispose";
      committed: boolean;
    },
    options?: ErrorOptions,
  ) {
    super(
      `${message}\nGateway generation ${details.generation}: replacement ${details.committed ? "applied" : "not applied"}.`,
      options,
    );
    this.name = "PluginRuntimeApplicationError";
  }
}

/** A receipt describes the published runtime, never authority to invoke it. */
export type PluginRuntimeApplication = {
  operationId: string;
  generation: number;
  pluginIds: string[];
  sourceDigests?: Record<string, string>;
  selectedEntries?: Record<string, string>;
  /** Registration applied, but process-shared code needs a Gateway restart. */
  restartRequired?: boolean;
  warnings?: string[];
};

export type PluginLifecycleReason =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "reload"
  | "metadata";

/** Project the published registry's captured-code facts into its application receipt. */
export function createPluginRuntimeApplication(params: {
  operationId: string;
  generation: number;
  registry: PluginRegistry;
  pluginIds: ReadonlySet<string>;
  reloadPluginIds?: ReadonlySet<string>;
  warnings: readonly string[];
}): PluginRuntimeApplication {
  const sourceDigests = new Map<string, string>();
  const selectedEntries = new Map<string, string>();
  const restartWarnings = new Set<string>();
  for (const record of params.registry.plugins) {
    if (!params.pluginIds.has(record.id)) {
      continue;
    }
    const instance = getPluginInstance(record);
    const entry = getPluginRuntimeEntrySource(record);
    if (instance && record.status === "loaded" && entry) {
      selectedEntries.set(record.id, entry);
    }
    if (instance?.sourceDigest) {
      sourceDigests.set(record.id, instance.sourceDigest);
    }
    if (
      params.reloadPluginIds?.has(record.id) &&
      record.enabled &&
      record.status === "loaded" &&
      instance
    ) {
      const warning = getSharedPluginCodeReloadWarning(instance);
      if (warning) {
        restartWarnings.add(warning);
      }
    }
  }
  const warnings = [...restartWarnings, ...params.warnings];
  return {
    operationId: params.operationId,
    generation: params.generation,
    pluginIds: [...params.pluginIds].toSorted(),
    sourceDigests: Object.fromEntries(sourceDigests),
    selectedEntries: Object.fromEntries(selectedEntries),
    ...(restartWarnings.size ? { restartRequired: true } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export type PluginLifecycleRuntimeApply = (params: {
  config: OpenClawConfig;
  write?: Pick<ConfigReplaceResult, "persistedHash" | "persistedSourceConfig">;
  pluginIds: readonly string[];
  reason: PluginLifecycleReason;
  /** Explicit reload admission wait; cancellation never owns recovery or published cleanup. */
  waitForDrain?: boolean;
  drainSignal?: AbortSignal;
  expectedSourceDigests?: Readonly<Record<string, string>>;
  /** Canonical install owners whose committed contents may already be running. */
  expectedInstallHashes?: Readonly<Record<string, string>>;
  /** Private invoker authority; never part of the published runtime receipt. */
  assertInvokerOwned?: () => void;
}) => Promise<PluginRuntimeApplication>;

/** Capture publications independently of later management or authority failures. */
export function capturePluginRuntimeApplications(applyRuntime: PluginLifecycleRuntimeApply) {
  let application: PluginRuntimeApplication | undefined;
  return {
    get application() {
      return application;
    },
    applyRuntime: async (params: Parameters<PluginLifecycleRuntimeApply>[0]) => {
      const next = await applyRuntime(params);
      const warnings = [...new Set([...(application?.warnings ?? []), ...(next.warnings ?? [])])];
      // Later publications replace generation facts, not earlier cleanup outcomes.
      application = warnings.length ? { ...next, warnings } : next;
      return application;
    },
  };
}

export function projectPluginRuntimeFailure(
  error: unknown,
  application?: PluginRuntimeApplication,
) {
  const persisted = error instanceof PluginInstallPersistedError ? error : undefined;
  const cause = persisted ? persisted.cause : error;
  const attempt = cause instanceof PluginRuntimeApplicationError ? cause.details : undefined;
  // A later rejected replacement does not undo an earlier publication in this operation.
  const previous = application && !attempt?.committed ? application : undefined;
  return {
    message:
      formatErrorMessage(cause) +
      (previous
        ? `\nAn earlier runtime change from this operation was applied in Gateway generation ${previous.generation}.`
        : ""),
    runtime: previous ? { ...previous, committed: true } : attempt,
    ...(previous && attempt ? { runtimeAttempt: attempt } : {}),
    ...(persisted
      ? { persistence: { operation: "install" as const, pluginId: persisted.pluginId } }
      : {}),
  };
}
