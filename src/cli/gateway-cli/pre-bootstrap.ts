import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  cloneEnvWithPlatformSemantics,
  resetPublishedConfigRuntimeEnv,
} from "../../config/config-env-vars.js";
// Gateway config selection and guards that precede shared CLI state preparation.
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "../../config/gateway-env-selection.js";
import { CONFIG_AUDIT_STORE_LABEL } from "../../config/io.audit.js";
import { describeConfigSnapshotInputChange } from "../../config/snapshot-inputs.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { formatCliCommand } from "../command-format.js";
import type { GatewayRunPreBootstrapOptions } from "./future-config-guard.js";
import { enforceGatewayRunFutureConfigGuard } from "./future-config-guard.js";
import type { GatewayRunOpts } from "./run-options.js";
import { getGatewayRunRuntimeHooks } from "./runtime-hooks.js";

type GatewayRunGuardParams = {
  opts: GatewayRunPreBootstrapOptions & Pick<GatewayRunOpts, "allowUnconfigured" | "dev">;
  runtime: RuntimeEnv;
};

type GatewayRunEnvironmentSelection = {
  after: Record<string, string | undefined>;
  before: Record<string, string | undefined>;
};

type PreparedGatewayRunReset = {
  selectionEnvironment: Record<string, string | undefined>;
  selectionSignature: string;
  snapshot: ConfigFileSnapshot;
};

let selectedGatewayRunEnvironment: GatewayRunEnvironmentSelection | undefined;
let appliedGatewayRunConfigEnvironment: GatewayRunEnvironmentSelection | undefined;
let lastGuardedGatewayRunSnapshot: ConfigFileSnapshot | undefined;
let preparedGatewayRunBootstrap:
  | (Pick<GatewayRunOpts, "allowUnconfigured" | "dev"> & { snapshot: ConfigFileSnapshot })
  | undefined;
let preparedGatewayRunReset: PreparedGatewayRunReset | undefined;
let gatewayRunTargetSelectedByConfig = false;

export function getGatewayStartGuardErrors(params: {
  allowUnconfigured?: boolean;
  configExists: boolean;
  mode: string | undefined;
}): string[] {
  if (
    (params.allowUnconfigured ?? preparedGatewayRunBootstrap?.allowUnconfigured) ||
    params.mode === "local" ||
    (!params.configExists && preparedGatewayRunBootstrap?.dev)
  ) {
    return [];
  }
  if (!params.configExists) {
    return [
      `Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`,
    ];
  }
  return [
    params.mode === undefined
      ? [
          "Gateway start blocked: existing config is missing gateway.mode.",
          "Treat this as suspicious or clobbered config.",
          `Re-run \`${formatCliCommand("openclaw onboard --mode local")}\` or \`${formatCliCommand("openclaw setup")}\`, set gateway.mode=local manually, or pass --allow-unconfigured.`,
        ].join(" ")
      : `Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`,
    `Config write audit: ${CONFIG_AUDIT_STORE_LABEL}`,
  ];
}

async function pinGatewayRunRuntimePaths(): Promise<void> {
  const [{ pinRuntimePaths }, { pinConfigDir }] = await Promise.all([
    import("../../config/paths.js"),
    import("../../utils.js"),
  ]);
  pinRuntimePaths(process.env);
  pinConfigDir(process.env);
}

const GATEWAY_RESET_SELECTION_ENV_KEYS = new Set([
  ...GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  "OPENCLAW_PROFILE",
  "OPENCLAW_WORKSPACE_DIR",
]);

function resolveGatewayConfigSelectionSignature(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, env[key]]));
}

function snapshotGatewayConfigSelectionEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries([...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, env[key]]));
}

function restoreGatewayConfigSelectionEnvironment(
  snapshot: Record<string, string | undefined>,
): void {
  for (const key of GATEWAY_CONFIG_SELECTION_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function resolveInvocationDestructiveOverride(): string | undefined {
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    delete process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
    return undefined;
  }
  return process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
}

function applyInvocationDestructiveOverride(value: string | undefined): void {
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim() || value === undefined) {
    delete process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
  } else {
    process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV] = value;
  }
}

function restoreGatewayEnvChanges(params: {
  before: Record<string, string | undefined>;
  after: Record<string, string | undefined>;
  preservedKeys?: ReadonlySet<string>;
}): void {
  const keys = new Set([...Object.keys(params.before), ...Object.keys(params.after)]);
  for (const key of keys) {
    const preservedKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (params.preservedKeys?.has(preservedKey)) {
      continue;
    }
    if (params.before[key] === params.after[key] || process.env[key] !== params.after[key]) {
      continue;
    }
    const previous = params.before[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

function restoreSupersededGatewaySelectionEnv(params: {
  beforeCurrentPass: Record<string, string | undefined>;
  environmentSelection?: GatewayRunEnvironmentSelection;
}): void {
  restoreGatewayEnvChanges({
    before: params.beforeCurrentPass,
    after: { ...process.env },
    preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  });
  if (params.environmentSelection) {
    // Remove only values introduced by the early selection phase. Later mutations such as
    // managed-proxy env differ from the recorded after-snapshot and remain intact.
    restoreGatewayEnvChanges({
      before: params.environmentSelection.before,
      after: params.environmentSelection.after,
      preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
    });
  }
}

function restoreAppliedGatewayRunConfigEnvironment(preserveSelection = true): void {
  const applied = appliedGatewayRunConfigEnvironment;
  appliedGatewayRunConfigEnvironment = undefined;
  if (!applied) {
    return;
  }
  restoreGatewayEnvChanges({
    before: applied.before,
    after: applied.after,
    ...(preserveSelection ? { preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS } : {}),
  });
}

async function readGuardedGatewayRunConfig(
  params: GatewayRunGuardParams,
): Promise<ConfigFileSnapshot | null> {
  const { readConfigFileSnapshot } = await import("../../config/config.js");
  const { createConfigIO } = await import("../../config/io.factory.js");
  return await withArtifactPreservingStateReads(async () => {
    const current = await readConfigFileSnapshot({
      isolateEnv: true,
      observe: false,
      pluginValidation: "core-only",
    });
    const guard = (snapshot: ConfigFileSnapshot) =>
      enforceGatewayRunFutureConfigGuard({ ...params, snapshot });
    if (!guard(current)) {
      return null;
    }
    const recovery = await createConfigIO({
      configPath: current.path,
      env: cloneEnvWithPlatformSemantics(process.env),
      observe: false,
      pluginValidation: "core-only",
    }).prepareConfigRecovery(current);
    return recovery ? (guard(recovery.snapshot) ? recovery.snapshot : null) : current;
  });
}

function describeGatewayRunConfigChange(
  expected: ConfigFileSnapshot,
  current: ConfigFileSnapshot,
  options: { allowPathChange?: boolean } = {},
): string | undefined {
  return current.valid !== expected.valid
    ? "config validity changed"
    : describeConfigSnapshotInputChange(expected, current, {
        ...options,
        // Invalid reset admission pins the selected target and authored revision.
        compareResolvedConfig: current.valid,
      });
}

function resolveGatewayConfigSelectionDeclarationSignature(
  entries: Record<string, string>,
): string {
  const normalized = new Map(
    Object.entries(entries).map(([key, value]) => [key.toUpperCase(), value]),
  );
  return JSON.stringify(
    [...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, normalized.get(key)]),
  );
}

async function guardGatewayRunSelectedConfig(
  params: GatewayRunGuardParams & {
    environmentSelection?: GatewayRunEnvironmentSelection;
  },
): Promise<boolean> {
  lastGuardedGatewayRunSnapshot = undefined;
  const [
    applyTrustedGatewayEnv,
    { applyConfigEnvVars },
    { normalizeEnv },
    { normalizeStateDirEnv },
    { collectEnvSecretRefIds },
    { clearMissingManagedServiceEnvKeys, readManagedSystemdServiceEnvKeysFromEnvironment },
  ] = await Promise.all([
    createTrustedGatewayEnvLoader(),
    import("../../config/config-env-vars.js"),
    import("../../infra/env.js"),
    import("../../config/paths.js"),
    import("../../config/resolution-facts.js"),
    import("../../daemon/service-managed-env.js"),
  ]);
  const invocationDestructiveOverride = resolveInvocationDestructiveOverride();
  if (params.environmentSelection) {
    restoreAppliedGatewayRunConfigEnvironment();
    restoreGatewayEnvChanges({
      before: params.environmentSelection.before,
      after: params.environmentSelection.after,
      preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
    });
  }
  const applySelectedConfigEnv = (snapshot: ConfigFileSnapshot) => {
    restoreAppliedGatewayRunConfigEnvironment(params.opts.reset !== true);
    if (snapshot.valid && params.opts.reset !== true) {
      const envBeforeApply = { ...process.env };
      applyConfigEnvVars(snapshot.sourceConfig, process.env);
      normalizeStateDirEnv(process.env);
      normalizeEnv();
      appliedGatewayRunConfigEnvironment = {
        before: envBeforeApply,
        after: { ...process.env },
      };
    }
    applyInvocationDestructiveOverride(invocationDestructiveOverride);
  };
  for (;;) {
    const envBeforeTrustedApply = { ...process.env };
    const trustedSelectionSignature = resolveGatewayConfigSelectionSignature(process.env);
    const trustedEnvLoad = applyTrustedGatewayEnv(invocationDestructiveOverride);
    if (resolveGatewayConfigSelectionSignature(process.env) !== trustedSelectionSignature) {
      const stateEnvSelectedTarget = trustedEnvLoad.stateEnvAppliedKeys.some((key) =>
        GATEWAY_CONFIG_SELECTION_ENV_KEYS.has(key.toUpperCase()),
      );
      if (stateEnvSelectedTarget) {
        const fallbackSelectorKeys = new Set(
          trustedEnvLoad.gatewayEnvAppliedKeys
            .map((key) => key.toUpperCase())
            .filter((key) => GATEWAY_CONFIG_SELECTION_ENV_KEYS.has(key)),
        );
        restoreGatewayEnvChanges({
          before: envBeforeTrustedApply,
          after: { ...process.env },
          preservedKeys: new Set(
            [...GATEWAY_CONFIG_SELECTION_ENV_KEYS].filter((key) => !fallbackSelectorKeys.has(key)),
          ),
        });
      }
      // A trusted dotenv selected another state/config target. Keep only its selectors so
      // credentials from the superseded dotenv cannot win over the selected target's dotenv.
      restoreSupersededGatewaySelectionEnv({
        beforeCurrentPass: envBeforeTrustedApply,
        environmentSelection: params.environmentSelection,
      });
      continue;
    }
    const snapshot = await readGuardedGatewayRunConfig(params);
    if (!snapshot) {
      return false;
    }
    if (!snapshot.valid && params.opts.reset) {
      // Invalid config source is untrusted. In particular, applying its env block could let an
      // off-root $include self-authorize OPENCLAW_INCLUDE_ROOTS on the next read. Only explicit dev
      // reset may proceed as the recovery path; ordinary startup skips mutation-capable bootstrap.
      lastGuardedGatewayRunSnapshot = snapshot;
      return true;
    }
    if (!snapshot.valid) {
      // Invalid authored config cannot choose runtime environment. The config guard
      // owns its detailed refusal and any explicitly selected Doctor recovery.
      lastGuardedGatewayRunSnapshot = snapshot;
      return true;
    }
    // The service marker also owns config SecretRefs. Only dotenv-absent keys with no current
    // config reference are stale; clearing the broad marker blindly would drop file-backed refs.
    clearMissingManagedServiceEnvKeys({
      environment: process.env,
      managedKeys: readManagedSystemdServiceEnvKeysFromEnvironment(process.env),
      presentKeys: trustedEnvLoad.dotenvPresentKeys,
      preserveKeys: collectEnvSecretRefIds(snapshot.sourceConfig),
    });
    const selectionSignature = resolveGatewayConfigSelectionSignature(process.env);
    applySelectedConfigEnv(snapshot);
    // Only selection inputs survive a selection hop. Reload credentials once the final config and
    // state dotenv are stable so a superseded profile cannot contaminate the selected gateway.
    if (resolveGatewayConfigSelectionSignature(process.env) !== selectionSignature) {
      // Config-selected roots have only config-level trust. Their dotenv files must keep the same
      // blocked-key boundary instead of becoming operator-trusted sources on the next pass.
      gatewayRunTargetSelectedByConfig = true;
      restoreSupersededGatewaySelectionEnv({
        beforeCurrentPass: envBeforeTrustedApply,
        environmentSelection: params.environmentSelection,
      });
      continue;
    }
    // Readiness owns current-config recovery; selection cannot write health or restore backups.
    lastGuardedGatewayRunSnapshot = snapshot;
    return true;
  }
}

async function guardGatewayRunReset(params: GatewayRunGuardParams): Promise<boolean> {
  gatewayRunTargetSelectedByConfig = false;
  const envBeforeGuard = { ...process.env };
  try {
    return await guardGatewayRunSelectedConfig(params);
  } finally {
    // Config being deleted cannot authorize or retarget its own reset. Restore its env layer first,
    // then retain only invocation/trusted selectors through deletion and recreation.
    restoreAppliedGatewayRunConfigEnvironment(false);
    // Reset keeps only the selected config/state target. Credentials and other env from the
    // config being deleted must not survive into the replacement config or gateway runtime.
    restoreGatewayEnvChanges({
      before: envBeforeGuard,
      after: { ...process.env },
      preservedKeys: GATEWAY_RESET_SELECTION_ENV_KEYS,
    });
  }
}

export async function recheckGatewayRunReset(params: GatewayRunGuardParams): Promise<boolean> {
  const expected = preparedGatewayRunReset;
  preparedGatewayRunReset = undefined;
  const rejectDrift = async () => {
    if (expected) {
      restoreGatewayConfigSelectionEnvironment(expected.selectionEnvironment);
      await pinGatewayRunRuntimePaths();
    }
    params.runtime.error(
      "Refusing to reset the dev gateway state because the selected config or state target changed during startup. Retry the reset so the new target can be validated.",
    );
    params.runtime.exit(1);
    return false;
  };
  if (
    !expected ||
    resolveGatewayConfigSelectionSignature(process.env) !== expected.selectionSignature
  ) {
    return await rejectDrift();
  }
  if (!(await guardGatewayRunReset(params))) {
    return false;
  }
  const current = lastGuardedGatewayRunSnapshot;
  if (
    resolveGatewayConfigSelectionSignature(process.env) !== expected.selectionSignature ||
    !current ||
    describeGatewayRunConfigChange(expected.snapshot, current)
  ) {
    return await rejectDrift();
  }
  return true;
}

export async function applyFinalGatewayRunConfigEnv(params: {
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  runtime: RuntimeEnv;
  snapshot: ConfigFileSnapshot;
}): Promise<boolean> {
  const preparedSnapshot = preparedGatewayRunBootstrap?.snapshot;
  preparedGatewayRunBootstrap = undefined;
  if (!params.snapshot.valid) {
    restoreAppliedGatewayRunConfigEnvironment(false);
    if (preparedSnapshot) {
      params.runtime.error(
        "Refusing to start the gateway because the final config read became invalid. Retry startup after fixing the config.",
      );
      params.runtime.exit(1);
      return false;
    }
    await pinGatewayRunRuntimePaths();
    return true;
  }
  const invocationDestructiveOverride = resolveInvocationDestructiveOverride();
  const envBeforeApply = { ...process.env };
  const selectionSignature = resolveGatewayConfigSelectionSignature(process.env);
  const [
    {
      applyConfigEnvVars,
      collectConfigRuntimeEnvOwnership,
      collectConfigRuntimeEnvVars,
      initializePublishedConfigRuntimeEnv,
    },
    { normalizeEnv },
    { normalizeStateDirEnv },
    { clearShellEnvAppliedKeys },
  ] = await Promise.all([
    import("../../config/config-env-vars.js"),
    import("../../infra/env.js"),
    import("../../config/paths.js"),
    import("../../infra/shell-env.js"),
  ]);
  const finalConfigEnv = collectConfigRuntimeEnvVars(params.snapshot.sourceConfig);
  if (
    preparedSnapshot &&
    resolveGatewayConfigSelectionDeclarationSignature(
      collectConfigRuntimeEnvVars(preparedSnapshot.sourceConfig),
    ) !== resolveGatewayConfigSelectionDeclarationSignature(finalConfigEnv)
  ) {
    params.runtime.error(
      "Refusing to start the gateway because the final config read changed config or state selection. Retry startup so the selected target can be validated.",
    );
    params.runtime.exit(1);
    return false;
  }
  restoreAppliedGatewayRunConfigEnvironment();
  const envBeforeConfigApply = { ...process.env };
  const replacedLowerPrecedenceKeys: string[] = [];
  applyConfigEnvVars(params.snapshot.sourceConfig, process.env, {
    lowerPrecedenceEnv: params.lowerPrecedenceEnv,
    onLowerPrecedenceKeysReplaced: (keys) => {
      replacedLowerPrecedenceKeys.push(...keys);
      clearShellEnvAppliedKeys(keys);
    },
  });
  normalizeStateDirEnv(process.env);
  normalizeEnv();
  applyInvocationDestructiveOverride(invocationDestructiveOverride);
  appliedGatewayRunConfigEnvironment = {
    before: envBeforeApply,
    after: { ...process.env },
  };
  if (resolveGatewayConfigSelectionSignature(process.env) === selectionSignature) {
    initializePublishedConfigRuntimeEnv(params.snapshot.sourceConfig, {
      ownedEnv: collectConfigRuntimeEnvOwnership(
        params.snapshot.sourceConfig,
        envBeforeConfigApply,
        process.env,
        { replacedLowerPrecedenceKeys },
      ),
    });
    return true;
  }
  appliedGatewayRunConfigEnvironment = undefined;
  restoreGatewayEnvChanges({ before: envBeforeApply, after: { ...process.env } });
  params.runtime.error(
    "Refusing to start the gateway because the final config read changed config or state selection. Retry startup so the selected target can be validated.",
  );
  params.runtime.exit(1);
  return false;
}

export function clearGatewayRunConfigEnvironment(): void {
  restoreAppliedGatewayRunConfigEnvironment();
  resetPublishedConfigRuntimeEnv();
}

async function createTrustedGatewayEnvLoader() {
  const [
    path,
    { isConfigRuntimeEnvVarAllowed },
    { loadGlobalRuntimeDotEnvFiles },
    { normalizeEnv },
    { normalizeStateDirEnv, resolveStateDir },
    { resolveConfigDir },
    { readManagedSystemdServiceEnvKeysFromEnvironment },
  ] = await Promise.all([
    import("node:path"),
    import("../../config/config-env-vars.js"),
    import("../../infra/dotenv-global.js"),
    import("../../infra/env.js"),
    import("../../config/paths.js"),
    import("../../utils.js"),
    import("../../daemon/service-managed-env.js"),
  ]);
  return (invocationDestructiveOverride: string | undefined) => {
    normalizeStateDirEnv(process.env);
    const stateEnvPath = path.join(resolveStateDir(process.env), ".env");
    const configEnvPath = path.join(resolveConfigDir(process.env), ".env");
    const loaded = loadGlobalRuntimeDotEnvFiles({
      ...(gatewayRunTargetSelectedByConfig ? { entryFilter: isConfigRuntimeEnvVarAllowed } : {}),
      overrideKeys: readManagedSystemdServiceEnvKeysFromEnvironment(process.env),
      quiet: true,
      stateEnvPath,
      ...(path.resolve(stateEnvPath) === path.resolve(configEnvPath)
        ? {}
        : { additionalEnvPaths: [configEnvPath] }),
    });
    normalizeStateDirEnv(process.env);
    normalizeEnv();
    applyInvocationDestructiveOverride(invocationDestructiveOverride);
    return loaded;
  };
}

export async function reloadTrustedGatewayRunEnvironment(params: {
  runtime: RuntimeEnv;
}): Promise<boolean> {
  const applyTrustedGatewayEnv = await createTrustedGatewayEnvLoader();
  const envBeforeReload = { ...process.env };
  const selectionSignature = resolveGatewayConfigSelectionSignature(process.env);
  const invocationDestructiveOverride = resolveInvocationDestructiveOverride();
  applyTrustedGatewayEnv(invocationDestructiveOverride);
  if (resolveGatewayConfigSelectionSignature(process.env) !== selectionSignature) {
    // Runtime modules already derived process-stable paths before startup mutations. A replacement
    // dotenv cannot select another target without splitting the running gateway across state dirs.
    restoreGatewayEnvChanges({ before: envBeforeReload, after: { ...process.env } });
    applyInvocationDestructiveOverride(invocationDestructiveOverride);
    await pinGatewayRunRuntimePaths();
    params.runtime.error(
      "Refusing to start the gateway because trusted dotenv reload after startup mutations changed config or state selection. Retry startup so the selected target can be validated.",
    );
    params.runtime.exit(1);
    return false;
  }
  await pinGatewayRunRuntimePaths();
  return true;
}

export async function selectGatewayRunEnvironment(params: GatewayRunGuardParams): Promise<boolean> {
  gatewayRunTargetSelectedByConfig = false;
  preparedGatewayRunBootstrap = undefined;
  preparedGatewayRunReset = undefined;
  restoreAppliedGatewayRunConfigEnvironment(params.opts.reset !== true);
  const envBeforeGuard = { ...process.env };
  selectedGatewayRunEnvironment = undefined;
  let guarded: boolean;
  try {
    guarded = await guardGatewayRunSelectedConfig(params);
  } finally {
    if (params.opts.reset) {
      restoreAppliedGatewayRunConfigEnvironment(false);
      restoreGatewayEnvChanges({
        before: envBeforeGuard,
        after: { ...process.env },
        preservedKeys: GATEWAY_RESET_SELECTION_ENV_KEYS,
      });
    }
  }
  selectedGatewayRunEnvironment = {
    before: envBeforeGuard,
    after: { ...process.env },
  };
  await pinGatewayRunRuntimePaths();
  return guarded;
}

export async function prepareGatewayRunBootstrap(params: GatewayRunGuardParams): Promise<boolean> {
  preparedGatewayRunReset = undefined;
  // Stop the early proxy before selection can choose another config/state target. Its lifecycle
  // restores the underlying env snapshot so the selected target's trusted dotenv can replace it.
  await getGatewayRunRuntimeHooks().releaseManagedProxy?.();
  const environmentSelection = selectedGatewayRunEnvironment;
  selectedGatewayRunEnvironment = undefined;
  if (!environmentSelection) {
    gatewayRunTargetSelectedByConfig = false;
  }
  const guarded = params.opts.reset
    ? await guardGatewayRunReset(params)
    : await guardGatewayRunSelectedConfig({
        ...params,
        environmentSelection,
      });
  await pinGatewayRunRuntimePaths();
  // Dev reset deletes the state directory before recreating config. Migrating first would
  // archive legacy state and then delete its imported SQLite rows.
  const shouldBootstrap = guarded && !params.opts.reset;
  preparedGatewayRunBootstrap =
    shouldBootstrap && lastGuardedGatewayRunSnapshot
      ? {
          snapshot: lastGuardedGatewayRunSnapshot,
          allowUnconfigured: params.opts.allowUnconfigured === true,
          dev:
            Boolean(params.opts.dev) ||
            normalizeOptionalLowercaseString(process.env.OPENCLAW_PROFILE) === "dev",
        }
      : undefined;
  if (guarded && params.opts.reset && lastGuardedGatewayRunSnapshot) {
    preparedGatewayRunReset = {
      selectionEnvironment: snapshotGatewayConfigSelectionEnvironment(process.env),
      selectionSignature: resolveGatewayConfigSelectionSignature(process.env),
      snapshot: lastGuardedGatewayRunSnapshot,
    };
  }
  return shouldBootstrap;
}

export async function recheckGatewayRunBootstrap(
  params: GatewayRunGuardParams & { snapshot?: ConfigFileSnapshot },
): Promise<boolean> {
  // This callback can run while startup preflight owns the shared preparation lease.
  // Throw a typed exit so its finally releases the lease before the CLI exits.
  const deferredExitRuntime: RuntimeEnv = {
    ...params.runtime,
    exit: (code) => {
      throw new ExitError(code);
    },
  };
  const expected = preparedGatewayRunBootstrap?.snapshot;
  if (!expected) {
    params.runtime.error(
      "Refusing to run gateway state preparation without a prepared config snapshot. Retry startup.",
    );
    throw new ExitError(1);
  }
  const current = params.snapshot
    ? enforceGatewayRunFutureConfigGuard({
        opts: params.opts,
        runtime: deferredExitRuntime,
        snapshot: params.snapshot,
      })
      ? params.snapshot
      : null
    : await readGuardedGatewayRunConfig({ ...params, runtime: deferredExitRuntime });
  if (!current) {
    return false;
  }
  // Selection already admitted any current-config backup. Later authored drift
  // must be validated by a new startup attempt.
  const change = describeGatewayRunConfigChange(expected, current, {
    allowPathChange: params.snapshot !== undefined,
  });
  if (!change) {
    return true;
  }
  params.runtime.error(
    `Refusing to run gateway state preparation because the selected config changed during startup (${change}). Retry startup so the new config can be validated.`,
  );
  throw new ExitError(1);
}
