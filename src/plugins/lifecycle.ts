import type { ConfigReplaceResult } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getActivePluginRegistryVersion } from "./runtime.js";

export const getPluginRuntimeGeneration = getActivePluginRegistryVersion;

/** Recorded only by the install persistence owner after its durable commit succeeds. */
export class PluginInstallPersistedError extends Error {
  constructor(
    readonly pluginId: string,
    cause: unknown,
  ) {
    super(formatErrorMessage(cause), { cause });
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
  warnings?: string[];
};

export type PluginLifecycleReason =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "reload"
  | "metadata";

export type PluginLifecycleRuntimeApply = (params: {
  config: OpenClawConfig;
  write?: Pick<ConfigReplaceResult, "persistedHash" | "persistedSourceConfig">;
  pluginIds: readonly string[];
  reason: PluginLifecycleReason;
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
