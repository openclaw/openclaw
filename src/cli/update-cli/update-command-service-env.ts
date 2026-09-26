import path from "node:path";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../../daemon/constants.js";
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

function applyManagedServiceSelectorEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  serviceEnv: NodeJS.ProcessEnv;
  selectorEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const resolved = { ...params.baseEnv };
  const selectorEnv = params.selectorEnv ?? params.serviceEnv;
  for (const key of MANAGED_UPDATE_SELECTOR_ENV_KEYS) {
    if (resolveEnvironmentValue(selectorEnv, key)?.trim()) {
      resolved[key] = params.serviceEnv[key];
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
          Object.entries(mergeProcessEnv([env])).map(([key, value]) => [key.toUpperCase(), value]),
        )
      : { ...env };
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

/** Run one update phase under the managed Gateway's authoritative environment. */
export async function withOwnedManagedUpdateEnv<T>(
  env: NodeJS.ProcessEnv | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!env) {
    return await run();
  }
  // Update finalization is a single serialized CLI phase. Some plugin/config owners still read
  // process.env, so switch the complete phase atomically and restore the caller afterward.
  const previousEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  // A caller may pass process.env itself; clearing it must not erase the supplied scope.
  const phaseEnv = env === process.env ? previousEnv : env;
  for (const [key, value] of Object.entries(phaseEnv)) {
    // Node stringifies undefined on assignment; unset selectors must remain absent.
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

/** Restore only this phase's overrides; other environment writes remain with their owners. */
export async function withUpdateEnv<T>(
  overrides: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  const apply = (entries: Iterable<readonly [string, string | undefined]>) => {
    for (const [key, value] of entries) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  apply(Object.entries(overrides));
  try {
    return await run();
  } finally {
    apply(previous);
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
  return disableUpdatedPackageCompileCacheEnv({
    ...processEnv,
    ...serviceEnv,
  });
}

export function resolveOwnedManagedUpdateEnv(params: {
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv: NodeJS.ProcessEnv;
  serviceDefinitionEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const resolved = resolveUpdatedInstallCommandEnv(params);
  const definitionEnv = params.serviceDefinitionEnv ?? params.serviceEnv;
  return applyManagedServiceSelectorEnv({
    baseEnv: resolved,
    serviceEnv: resolved,
    selectorEnv: definitionEnv,
  });
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
  return applyManagedServiceSelectorEnv({ baseEnv: resolvedEnv, serviceEnv });
}
