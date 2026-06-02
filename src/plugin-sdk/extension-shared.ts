import { createAmbientNodeProxyAgent, hasAmbientNodeProxyConfigured } from "@openclaw/proxyline";
import type { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { resolveActiveManagedProxyTlsOptions } from "../infra/net/proxy/managed-proxy-undici.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { runPassiveAccountLifecycle } from "./channel-lifecycle.core.js";
import { createLoggerBackedRuntime } from "./runtime-logger.js";
export { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
export { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";

type PassiveChannelStatusSnapshot = {
  configured?: boolean;
  running?: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: unknown;
  lastProbeAt?: number | null;
};

type TrafficStatusSnapshot = {
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
};

type StoppableMonitor = {
  stop: () => void;
};

type RequireOpenAllowFromFn = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => void;

/** Builds the common status payload for passive channel runtimes. */
export function buildPassiveChannelStatusSummary<TExtra extends object>(
  snapshot: PassiveChannelStatusSnapshot,
  extra?: TExtra,
) {
  return {
    configured: snapshot.configured ?? false,
    ...(extra ?? ({} as TExtra)),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

/** Builds a passive status payload that also includes the latest probe result. */
export function buildPassiveProbedChannelStatusSummary<TExtra extends object>(
  snapshot: PassiveChannelStatusSnapshot,
  extra?: TExtra,
) {
  return {
    ...buildPassiveChannelStatusSummary(snapshot, extra),
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
}

/** Builds normalized inbound/outbound traffic timestamps for status surfaces. */
export function buildTrafficStatusSummary(snapshot?: TrafficStatusSnapshot | null) {
  return {
    lastInboundAt: snapshot?.lastInboundAt ?? null,
    lastOutboundAt: snapshot?.lastOutboundAt ?? null,
  };
}

/** Runs a passive monitor until abort and calls the monitor's stop hook during shutdown. */
export async function runStoppablePassiveMonitor<TMonitor extends StoppableMonitor>(params: {
  /** Abort signal that owns the passive monitor lifecycle. */
  abortSignal: AbortSignal;
  /** Starts the underlying monitor and returns its stop handle. */
  start: () => Promise<TMonitor>;
}): Promise<void> {
  await runPassiveAccountLifecycle({
    abortSignal: params.abortSignal,
    start: params.start,
    stop: async (monitor) => {
      monitor.stop();
    },
  });
}

/** Returns an injected runtime or creates a logger-backed runtime for bundled extension tests. */
export function resolveLoggerBackedRuntime<TRuntime>(
  runtime: TRuntime | undefined,
  logger: Parameters<typeof createLoggerBackedRuntime>[0]["logger"],
): TRuntime {
  return (
    runtime ??
    (createLoggerBackedRuntime({
      logger,
      exitError: () => new Error("Runtime exit not available"),
    }) as TRuntime)
  );
}

/** Adds the standard open-DM allowFrom validation issue for channel config schemas. */
export function requireChannelOpenAllowFrom(params: {
  /** Channel id used to build the config path in the validation message. */
  channel: string;
  /** DM policy value being validated. */
  policy?: string;
  /** Configured allowFrom entries for the channel. */
  allowFrom?: Array<string | number>;
  /** Zod refinement context that receives the issue. */
  ctx: z.RefinementCtx;
  /** Shared policy validator injected by the channel schema. */
  requireOpenAllowFrom: RequireOpenAllowFromFn;
}) {
  params.requireOpenAllowFrom({
    policy: params.policy,
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    path: ["allowFrom"],
    message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
  });
}

/** Reads selected status issue fields from an unknown issue-like value. */
export function readStatusIssueFields<TField extends string>(
  value: unknown,
  fields: readonly TField[],
): Record<TField, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const result = {} as Record<TField, unknown>;
  for (const field of fields) {
    result[field] = record[field];
  }
  return result;
}

/** Coerces supported account-id field values from status issues. */
export function coerceStatusIssueAccountId(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/** Creates a Promise with exposed resolve/reject hooks for lifecycle bridges. */
export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DEFAULT_PACKAGE_JSON_VERSION_CANDIDATES = [
  "../package.json",
  "./package.json",
  "../../package.json",
] as const;

type PackageJsonRequire = (id: string) => unknown;

type PluginConfigIssuePathSegment = string | number;

type PluginConfigIssue = {
  path: PluginConfigIssuePathSegment[];
  message: string;
};

type PluginConfigIssueMessageOptions = {
  invalidConfigMessage?: string;
  unknownKeyMessage?: (key: string) => string;
  rootInvalidTypeMessage?: string;
};

/** Formats a Zod config issue into short user-facing channel/plugin config text. */
export function formatPluginConfigIssue(
  issue: z.ZodIssue | undefined,
  options?: PluginConfigIssueMessageOptions,
): string {
  if (!issue) {
    return options?.invalidConfigMessage ?? "invalid config";
  }
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return options?.unknownKeyMessage?.(issue.keys[0]) ?? `unknown config key: ${issue.keys[0]}`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return options?.rootInvalidTypeMessage ?? "expected config object";
  }
  return issue.message;
}

/** Keeps only string/number path segments that can be returned in plugin config issues. */
export function normalizePluginConfigIssuePath(
  path: readonly unknown[],
): PluginConfigIssuePathSegment[] {
  return path.filter((segment): segment is PluginConfigIssuePathSegment => {
    const kind = typeof segment;
    return kind === "string" || kind === "number";
  });
}

/** Maps Zod config issues into stable path/message objects for plugin status/config APIs. */
export function mapPluginConfigIssues(
  issues: readonly z.ZodIssue[],
  options?: PluginConfigIssueMessageOptions,
): PluginConfigIssue[] {
  return issues.map((issue) => ({
    path: normalizePluginConfigIssuePath(issue.path),
    message: formatPluginConfigIssue(issue, options),
  }));
}

/** Checks whether a read-only env secret ref can be resolved without mutating config. */
export function canResolveEnvSecretRefInReadOnlyPath(params: {
  /** Config containing secret provider declarations. */
  cfg?: OpenClawConfig;
  /** Secret provider alias from the ref. */
  provider: string;
  /** Secret id from the ref. */
  id: string;
}): boolean {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
  }
  if (providerConfig.source !== "env") {
    return false;
  }
  const allowlist = providerConfig.allowlist;
  return !allowlist || allowlist.includes(params.id);
}

/** Reads plugin package version across source and bundled package layouts. */
export function readPluginPackageVersion(params: {
  /** CommonJS-style require scoped to the plugin module. */
  require: PackageJsonRequire;
  /** Candidate package.json paths to try, in order. */
  candidates?: readonly string[];
  /** Value returned when no candidate exposes a non-empty version. */
  fallback?: string;
}): string {
  for (const candidate of params.candidates ?? DEFAULT_PACKAGE_JSON_VERSION_CANDIDATES) {
    try {
      const version = (params.require(candidate) as { version?: unknown }).version;
      if (typeof version === "string" && version.trim().length > 0) {
        return version;
      }
    } catch {
      // Ignore missing candidate paths across source and bundled layouts.
    }
  }
  return params.fallback ?? "unknown";
}

/** Resolves an ambient Node proxy agent when proxy env/config is present. */
export async function resolveAmbientNodeProxyAgent<TAgent>(params?: {
  /** Error observer for proxy agent construction failures. */
  onError?: (error: unknown) => void;
  /** Called when an ambient proxy agent is actually returned. */
  onUsingProxy?: () => void;
  /** Protocol whose ambient proxy settings should be inspected. */
  protocol?: "http" | "https";
}): Promise<TAgent | undefined> {
  const protocol = params?.protocol ?? "https";
  if (!hasAmbientNodeProxyConfigured({ protocol })) {
    return undefined;
  }
  try {
    // Managed proxy TLS state is process-local and only applies when the active proxy owns it.
    const proxyTls = resolveActiveManagedProxyTlsOptions();
    const agent = createAmbientNodeProxyAgent({
      protocol,
      ...(proxyTls ? { proxyTls } : {}),
    });
    if (agent === undefined) {
      return undefined;
    }
    params?.onUsingProxy?.();
    return agent as TAgent;
  } catch (error) {
    params?.onError?.(error);
    return undefined;
  }
}
