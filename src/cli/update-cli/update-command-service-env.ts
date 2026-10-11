import path from "node:path";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../../daemon/constants.js";
import {
  clearFsSafeEnvFallback,
  fsSafeEnvInput,
  normalizeFsSafeNativeEnv,
} from "../../infra/fs-safe-env.js";
import { mergePathPrepend } from "../../infra/path-prepend.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../../infra/process-env.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";

const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_WORKSPACE_DIR",
] as const;
const MANAGED_UPDATE_SELECTOR_ENV_KEYS = [
  "OPENCLAW_HOME",
  ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
] as const;
const OPERATOR_SCRATCH_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

/** Recovery can be printed inside an owned-env scope that the operator's shell never had. */
export function resolveServiceRecoveryContext(
  params: Parameters<typeof resolveOwnedManagedUpdateEnv>[0],
): { env: NodeJS.ProcessEnv; command: string } {
  const env = resolveOwnedManagedUpdateEnv(params);
  const keys = [
    ...new Set([...MANAGED_UPDATE_SELECTOR_ENV_KEYS, ...SERVICE_REFRESH_PATH_ENV_KEYS]),
  ];
  if (process.platform === "win32") {
    return {
      env,
      command: keys
        .map((key) =>
          env[key] === undefined
            ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue`
            : `$env:${key} = ${quotePowerShellArg(env[key])}`,
        )
        .join("; "),
    };
  }
  const assigned = keys.flatMap((key) =>
    env[key] === undefined ? [] : [`${key}=${quoteCliArg(env[key])}`],
  );
  const unset = keys.filter((key) => env[key] === undefined);
  return {
    env,
    command: [
      assigned.length ? `export ${assigned.join(" ")}` : "",
      unset.length ? `unset ${unset.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  };
}

function applyManagedServiceSelectorEnv(
  resolved: NodeJS.ProcessEnv,
  serviceEnv: NodeJS.ProcessEnv,
  selectorEnv = serviceEnv,
): NodeJS.ProcessEnv {
  for (const key of MANAGED_UPDATE_SELECTOR_ENV_KEYS) {
    if (resolveEnvironmentValue(selectorEnv, key)?.trim()) {
      resolved[key] = serviceEnv[key];
    } else {
      delete resolved[key];
    }
  }
  return resolved;
}

export function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  // A plain copy loses Windows process.env's case-insensitive lookups. Keep
  // immutable snapshots usable by the config and database path resolvers.
  const resolvedEnv: NodeJS.ProcessEnv =
    process.platform === "win32"
      ? Object.fromEntries(
          Object.entries(mergeProcessEnv([fsSafeEnvInput(env)])).map(([key, value]) => [
            key.toUpperCase(),
            value,
          ]),
        )
      : { ...fsSafeEnvInput(env) };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    resolvedEnv[key] =
      !invocationCwd ||
      rawValue.startsWith("~") ||
      path.isAbsolute(rawValue) ||
      path.win32.isAbsolute(rawValue)
        ? rawValue
        : path.resolve(invocationCwd, rawValue);
  }
  return resolvedEnv;
}

function applyUpdateEnv(
  entries: Iterable<readonly [string, string | undefined]>,
  replace: boolean,
): void {
  clearFsSafeEnvFallback(process.env);
  if (replace) {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of entries) {
    // A full snapshot skips undefined; an overlay uses it to unset a selector.
    if (value !== undefined) {
      process.env[key] = value;
    } else if (!replace) {
      delete process.env[key];
    }
  }
  normalizeFsSafeNativeEnv();
}

/** Run one update phase under the managed Gateway's authoritative environment. */
export async function withOwnedManagedUpdateEnv<T>(
  env: NodeJS.ProcessEnv | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return env ? await withUpdateEnvScope(env, run, true) : await run();
}

/** Restore only this phase's overrides; other environment writes remain with their owners. */
export async function withUpdateEnv<T>(
  overrides: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  return await withUpdateEnvScope(overrides, run, false);
}

async function withUpdateEnvScope<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
  replace: boolean,
): Promise<T> {
  const inputs = fsSafeEnvInput(env);
  const before = fsSafeEnvInput(process.env);
  // Snapshot aliased inputs before replacing process.env; overlays restore only their keys.
  const previous = replace
    ? Object.entries(before)
    : Object.keys(inputs).map(
        (key) =>
          [
            key,
            process.platform === "win32" ? resolveEnvironmentValue(before, key) : before[key],
          ] as const,
      );
  applyUpdateEnv(Object.entries(inputs), replace);
  try {
    return await run();
  } finally {
    applyUpdateEnv(previous, replace);
  }
}

export async function withUpdateInProgressEnv<T>(
  invocationCwd: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const env = resolveServiceRefreshEnv(process.env, invocationCwd);
  env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  // Package replacement can remove cwd. Retain resolved selectors through cleanup.
  const overrides = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => key === "OPENCLAW_UPDATE_IN_PROGRESS" || value !== process.env[key],
    ),
  );
  return await withUpdateEnv(overrides, run);
}

export function stripGatewayServiceMarkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolvedEnv = { ...env };
  delete resolvedEnv.OPENCLAW_SERVICE_MARKER;
  delete resolvedEnv.OPENCLAW_SERVICE_KIND;
  delete resolvedEnv[GATEWAY_SERVICE_RUNTIME_PID_ENV];
  return resolvedEnv;
}

export function disableUpdatedPackageCompileCacheEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

export function resolveUpdatedInstallCommandEnv(params?: {
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const processEnv = resolveServiceRefreshEnv(
    params?.processEnv ?? process.env,
    params?.invocationCwd,
  );
  const serviceEnv = params?.serviceEnv
    ? resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd)
    : undefined;
  // SecretRefs may resolve from the updater's runtime env even when the
  // managed service intentionally omits resolved secrets from its definition.
  const resolved = { ...processEnv, ...serviceEnv };
  // The service owns installation selectors; the invoking operator owns scratch placement.
  for (const key of OPERATOR_SCRATCH_ENV_KEYS) {
    if (processEnv[key] !== undefined) {
      resolved[key] = processEnv[key];
    }
  }
  return disableUpdatedPackageCompileCacheEnv(resolved);
}

export function resolveOwnedManagedUpdateEnv(
  params: NonNullable<Parameters<typeof resolveUpdatedInstallCommandEnv>[0]> & {
    serviceEnv: NodeJS.ProcessEnv;
    serviceDefinitionEnv?: NodeJS.ProcessEnv;
  },
): NodeJS.ProcessEnv {
  const resolved = resolveUpdatedInstallCommandEnv(params);
  return applyManagedServiceSelectorEnv(
    resolved,
    resolved,
    params.serviceDefinitionEnv ?? params.serviceEnv,
  );
}

export function resolveUpdateTargetEnv(params?: {
  baseEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  nodeRunner?: string;
}): NodeJS.ProcessEnv {
  const resolvedEnv = disableUpdatedPackageCompileCacheEnv(
    resolveServiceRefreshEnv(params?.baseEnv ?? process.env, params?.invocationCwd),
  );
  if (params?.nodeRunner) {
    resolvedEnv.PATH = mergePathPrepend(resolvedEnv.PATH, [path.dirname(params.nodeRunner)]);
  }
  if (!params?.serviceEnv) {
    return resolvedEnv;
  }
  const serviceEnv = resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd);
  return applyManagedServiceSelectorEnv(resolvedEnv, serviceEnv);
}
