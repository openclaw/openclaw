// Shared execution helpers keep the public dispatcher small and reviewable.
import { getAtPath, parseConfigSetPath } from "../cli/config-cli-path.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  projectDefaultInferenceRoute,
  projectInferenceRoute,
  sameDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";
import type {
  SystemAgentCommandDeps,
  SystemAgentOperation,
  SystemAgentOperationResult,
} from "./operations-parse.js";
import { formatSystemAgentPersistentPlan } from "./operations-parse.js";
import type { SystemAgentOverview } from "./overview.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

export const CONFIG_GET_OUTPUT_MAX_CHARS = 2_000;
export const CONFIG_SCHEMA_CHILDREN_MAX = 40;

export function readConfigValueAtPath(
  config: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  let current: unknown = config;
  for (const part of parseConfigSetPath(path)) {
    if (current === null || typeof current !== "object") {
      return { found: false };
    }
    // Reads allow array properties and indices beyond the CLI writer's sparse-write limit.
    const index = /^\d+$/.test(part) ? Number(part) : undefined;
    if (index !== undefined && Array.isArray(current)) {
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined) {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export function formatGatewayStatusLine(overview: SystemAgentOverview): string {
  return [
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"}`,
    `URL: ${overview.gateway.url}`,
    `Source: ${overview.gateway.source}`,
    overview.gateway.error ? `Note: ${overview.gateway.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function runGatewayLifecycle(
  operation: "start" | "stop" | "restart",
): Promise<void | boolean> {
  const lifecycle = await import("../cli/daemon-cli/lifecycle.js");
  if (operation === "start") {
    await lifecycle.runDaemonStart();
    return;
  }
  if (operation === "stop") {
    // The system-agent approval gate is the non-interactive equivalent of an
    // operator passing --force after explicitly approving the mutation.
    await lifecycle.runDaemonStop({ force: true });
    return;
  }
  return await lifecycle.runDaemonRestart();
}

export async function readConfigFileSnapshotLazy(): Promise<ConfigFileSnapshot> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  return await readConfigFileSnapshot();
}

export async function loadOverviewForOperation(
  deps: SystemAgentCommandDeps | undefined,
): Promise<SystemAgentOverview> {
  if (deps?.loadOverview) {
    return await deps.loadOverview();
  }
  const { loadSystemAgentOverview } = await import("./overview.js");
  return await loadSystemAgentOverview();
}

export async function resolveChannelSetupState(deps: SystemAgentCommandDeps | undefined) {
  const listPlugins =
    deps?.listChannelSetupPlugins ??
    (await import("../channels/plugins/setup-registry.js")).listChannelSetupPlugins;
  const resolveEntries =
    deps?.resolveChannelSetupEntries ??
    (await import("../commands/channel-setup/discovery.js")).resolveChannelSetupEntries;
  const isConfigured =
    deps?.isChannelConfigured ??
    (await import("../config/channel-configured-shared.js")).isStaticallyChannelConfigured;
  const { shouldShowChannelInSetup } = await import("../commands/channel-setup/discovery.js");
  const snapshot = await readConfigFileSnapshotLazy();
  const cfg = snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const installedPlugins = listPlugins();
  const resolved = resolveEntries({ cfg, installedPlugins });
  return {
    cfg,
    installedPlugins,
    resolved: {
      ...resolved,
      // Match the connect/list surfaces: setup-hidden channels stay invisible
      // to chat listings and channel info alike.
      entries: resolved.entries.filter((entry) => shouldShowChannelInSetup(entry.meta)),
    },
    isConfigured,
  };
}

export function formatChannelDocsUrl(docsPath: string): string {
  return `https://docs.openclaw.ai${docsPath.startsWith("/") ? docsPath : `/${docsPath}`}`;
}

export function formatConfigValidationLine(snapshot: ConfigFileSnapshot): string {
  if (!snapshot.exists) {
    return `Config missing: ${shortenHomePath(snapshot.path)}`;
  }
  if (snapshot.valid) {
    return `Config valid: ${shortenHomePath(snapshot.path)}`;
  }
  return [
    `Config invalid: ${shortenHomePath(snapshot.path)}`,
    ...snapshot.issues.map((issue) => {
      const issuePath = issue.path ? `${issue.path}: ` : "";
      return `  - ${issuePath}${issue.message}`;
    }),
  ].join("\n");
}

/** A CLI command already wrote its failure to the runtime before calling exit. */
export class SystemAgentOperationExitError extends Error {
  constructor(code: number | undefined) {
    super(`operation exited with code ${code}`);
  }
}

export function createNoExitRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code) => {
      throw new SystemAgentOperationExitError(code);
    },
  };
}

export function resolveTuiAgentId(params: {
  requestedAgentId: string | undefined;
  requestedWorkspace?: string;
  overview: SystemAgentOverview;
}): string | undefined {
  const { overview } = params;
  const workspace = params.requestedWorkspace
    ? resolveUserPath(params.requestedWorkspace)
    : undefined;
  if (workspace) {
    const workspaceMatch = overview.agents.find((agent) => {
      return agent.workspace ? resolveUserPath(agent.workspace) === workspace : false;
    });
    if (workspaceMatch) {
      return workspaceMatch.id;
    }
  }
  if (!params.requestedAgentId?.trim()) {
    return overview.defaultAgentId;
  }
  const requested = normalizeAgentId(params.requestedAgentId);
  const match = overview.agents.find((agent) => {
    return (
      normalizeAgentId(agent.id) === requested ||
      (agent.name ? normalizeAgentId(agent.name) === requested : false)
    );
  });
  return match?.id ?? requested;
}

/** Utility inference can power setup without making an ordinary agent ready. */
export function getRegularAgentSetupNotice(
  overview: SystemAgentOverview,
  agentId = overview.defaultAgentId,
): string | undefined {
  const requestedId = normalizeAgentId(agentId);
  const isDefault = requestedId === normalizeAgentId(overview.defaultAgentId);
  const agent = overview.agents.find((entry) => normalizeAgentId(entry.id) === requestedId);
  const primaryModel = agent?.model ?? (isDefault ? overview.defaultModel : undefined);
  const utilityModel = agent?.utilityModel ?? (isDefault ? overview.setupModel : undefined);
  if (primaryModel || !utilityModel) {
    return undefined;
  }
  return "Your setup and utility model is ready, but this agent needs a primary model. Choose one in Model Setup or run `openclaw onboard`; you can continue setup here in the meantime.";
}

export type ExecuteOptions = {
  approved?: boolean;
  /** Host-owned origin for team members; never supplied by model tool arguments. */
  requesterAgentId?: string;
  operatorApprovalOnly?: boolean;
  deps?: SystemAgentCommandDeps;
  auditDetails?: Record<string, unknown>;
  /**
   * Authority check used by the guarded commit seam for host-approved writes.
   * A multi-step operation may invoke it more than once; every invocation is
   * immediately followed by the persistent effect it authorizes.
   */
  beforePersistentApply?: () => void;
  /** Adopt the exact final binding after a verified model-route write commits. */
  onVerifiedInferenceChanged?: (binding: SystemAgentVerifiedInferenceBinding) => void;
};

/**
 * One persistent operation = one audited apply. The shared wrapper owns the
 * approval gate, before/after config hashes, the audit record, and the
 * `[openclaw] running/done` markers the e2e lanes assert on; each spec only
 * describes what to run and what to record.
 */
type PersistentApplyContext = {
  runtime: RuntimeEnv;
  deps?: SystemAgentCommandDeps;
  /** Synchronous authority guard for the owner immediately before mutation. */
  assertPersistentApply?: () => void;
  /** Re-check authority, then enter one persistent side-effect boundary. */
  commit<T>(effect: () => Promise<T> | T): Promise<T>;
};

type PersistentApplyOutcome = {
  summary: string;
  bootstrapPending?: boolean;
  agentId?: string;
  details?: Record<string, unknown>;
  /** Overrides the after-snapshot config path in the audit record. */
  configPath?: string;
};

export async function applyPersistentOperation(params: {
  auditOperation: string;
  operation: SystemAgentOperation;
  runtime: RuntimeEnv;
  opts: ExecuteOptions;
  run: (ctx: PersistentApplyContext) => Promise<PersistentApplyOutcome>;
}): Promise<SystemAgentOperationResult> {
  const { auditOperation, runtime, opts } = params;
  if (!opts.approved) {
    const message = formatSystemAgentPersistentPlan(params.operation, opts.operatorApprovalOnly);
    runtime.log(message);
    return { applied: false, message };
  }
  runtime.log(`[openclaw] running: ${auditOperation}`);
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const before = await readConfigFileSnapshot();
  const assertPersistentApply = opts.beforePersistentApply;
  const commit: PersistentApplyContext["commit"] = async (effect) => {
    assertPersistentApply?.();
    return await effect();
  };
  const outcome = await params.run({
    runtime,
    deps: opts.deps,
    ...(assertPersistentApply ? { assertPersistentApply } : {}),
    commit,
  });
  const after = await readConfigFileSnapshot();
  try {
    await appendSystemAgentAuditEntry({
      operation: auditOperation,
      summary: outcome.summary,
      configPath: outcome.configPath ?? after.path ?? before.path ?? undefined,
      configHashBefore: hashConfigRaw(before.raw),
      configHashAfter: hashConfigRaw(after.raw),
      details: { ...opts.auditDetails, ...outcome.details },
    });
  } catch (error) {
    // The mutation already committed. Keep success truthful while making the
    // missing audit record visible to every CLI/chat capture surface.
    runtime.error(
      `${outcome.summary}, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`,
    );
  }
  runtime.log(`[openclaw] done: ${auditOperation}`);
  return {
    applied: true,
    ...(outcome.bootstrapPending === undefined
      ? {}
      : { bootstrapPending: outcome.bootstrapPending }),
    ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
  };
}

export async function runConfigSetOperation(params: {
  operation: Extract<SystemAgentOperation, { kind: "config-set" | "config-set-ref" }>;
  ctx: PersistentApplyContext;
}): Promise<{ storeEntry?: string; storeProvider?: string }> {
  const { operation, ctx } = params;
  const runConfigSet =
    ctx.deps?.runConfigSet ??
    (async (setOpts: Parameters<NonNullable<SystemAgentCommandDeps["runConfigSet"]>>[0]) => {
      const { runConfigSet: importedRunConfigSet } = await import("../cli/config-cli.js");
      await importedRunConfigSet({
        ...setOpts,
        runtime: createNoExitRuntime(ctx.runtime),
        throwOnError: operation.kind === "config-set-ref" && operation.secret !== undefined,
      });
    });
  const beforePersistentApply = ctx.assertPersistentApply
    ? { beforePersistentApply: ctx.assertPersistentApply }
    : {};
  if (operation.kind === "config-set" || operation.secret === undefined) {
    await ctx.commit(() =>
      runConfigSet({
        path: operation.path,
        ...(operation.kind === "config-set"
          ? { value: operation.value, cliOptions: {} }
          : {
              cliOptions: {
                refProvider: operation.provider ?? "default",
                refSource: operation.source,
                refId: operation.id,
              },
            }),
        ...beforePersistentApply,
      }),
    );
    return {};
  }
  const secret = operation.secret;
  const snapshot = await readConfigFileSnapshotLazy();
  const configPath = parseConfigSetPath(operation.path);
  const currentRef = coerceSecretRef(
    getAtPath(snapshot.sourceConfig, configPath).value,
    snapshot.config.secrets?.defaults,
  );
  const defaultStoreProvider = resolveDefaultSecretProviderAlias(snapshot.config, "store", {
    preferFirstProviderForSource: true,
  });
  // Rotating a key keeps the store provider it already uses.
  const refProvider =
    operation.provider ??
    (currentRef?.source === "store" &&
    (currentRef.provider === defaultStoreProvider ||
      snapshot.config.secrets?.providers?.[currentRef.provider]?.source === "store")
      ? currentRef.provider
      : defaultStoreProvider);
  // The SQLite store stays off the load path of every other config write.
  const { writeSecretStoreEntryForConfigRef } = await import("../secrets/store/secret-store.js");
  // Every save gets a fresh entry and no entry is ever overwritten or deleted
  // here: another config key or auth profile may use, or start using, any
  // entry at any time. The new ref is picked up by the normal config reload.
  const storeEntry = await ctx.commit(() =>
    writeSecretStoreEntryForConfigRef({
      baseName: operation.id,
      value: secret,
      updatedBy: "openclaw",
      // The worker re-checks the requester at transaction and commit admission.
      ...(ctx.assertPersistentApply ? { assertCurrent: ctx.assertPersistentApply } : {}),
    }),
  );
  try {
    await runConfigSet({
      path: operation.path,
      cliOptions: { refProvider, refSource: "store", refId: storeEntry },
      ...beforePersistentApply,
    });
  } catch (error) {
    // The writer can fail after publication and can decline or fail rollback.
    // Reconcile persisted source, not the possibly stale active runtime snapshot.
    const postCommit = error instanceof ConfigWritePostCommitError ? error : undefined;
    let referenceState = `Could not establish whether ${operation.path} references the saved entry.`;
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const current = await readConfigFileSnapshot({ observe: false, isolateEnv: true });
      if (
        current.path === (postCommit?.configPath ?? snapshot.path) &&
        current.exists &&
        current.valid
      ) {
        const ref = coerceSecretRef(
          getAtPath(current.sourceConfig, configPath).value,
          current.config.secrets?.defaults,
        );
        const referencesEntry = ref?.source === "store" && ref.id === storeEntry;
        referenceState = `At the recovery check, ${operation.path} ${referencesEntry ? "referenced" : "did not reference"} the saved entry.`;
      }
    } catch {
      // An unreadable/invalid config is unknown, never evidence of non-use.
    }
    // Even an absent target ref cannot certify non-use by other config/auth
    // consumers or later writers. Keep the entry and never offer blind cleanup.
    throw new Error(
      [
        `Saved the secret as ${storeEntry}, but ${postCommit ? "config post-write processing" : "the config operation"} failed: ${formatErrorMessage(error)}`,
        referenceState,
        "The entry was kept; other config keys or auth profiles may use it. Do not remove it while references are present or uncertain.",
        "Resolve the config/runtime error and inspect current references before retrying; reuse the saved entry instead of saving the secret again.",
      ].join(" "),
      { cause: error },
    );
  }
  return { storeEntry, storeProvider: refProvider };
}

async function verifyCurrentSetupInference(
  runtime: RuntimeEnv,
  deps?: SystemAgentCommandDeps,
): Promise<{
  modelRef: string;
  route: DefaultInferenceRouteProjection;
  latencyMs: number;
}> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const before = await readConfigFileSnapshot();
  if (!before.exists || !before.valid) {
    throw new Error(
      "OpenClaw setup requires a valid configured inference route. Run `openclaw onboard` on the machine running OpenClaw, then retry.",
    );
  }
  const beforeConfig = before.runtimeConfig ?? before.config;
  const beforeRoute = await projectDefaultInferenceRoute(beforeConfig);
  if (!beforeRoute.route) {
    throw new Error(
      "OpenClaw setup requires working inference first. Run `openclaw onboard` on the machine running OpenClaw, then retry.",
    );
  }
  const verifyInferenceConfig =
    deps?.verifyInferenceConfig ??
    (await import("./setup-inference.js")).verifySetupInferenceConfig;
  const verification = await verifyInferenceConfig({ config: beforeConfig, runtime });
  if (!verification.ok) {
    throw new Error(
      `OpenClaw setup requires working inference first. The configured route failed a live check: ${verification.error} Run \`openclaw onboard\` on the machine running OpenClaw, then retry.`,
    );
  }

  const after = await readConfigFileSnapshot();
  if (!after.exists || !after.valid) {
    throw new Error(
      "The default-agent inference route changed during setup verification, so setup was not applied. Review the current config and retry.",
    );
  }
  const afterConfig = after.runtimeConfig ?? after.config;
  const afterRoute = await projectDefaultInferenceRoute(afterConfig);
  if (
    !sameDefaultInferenceRoute(beforeRoute, afterRoute) ||
    verification.modelRef !== afterRoute.route?.modelLabel
  ) {
    throw new Error(
      "The default-agent inference route changed during setup verification, so setup was not applied. Review the current model/auth/runtime settings and retry.",
    );
  }
  return {
    modelRef: verification.modelRef,
    route: afterRoute,
    latencyMs: verification.latencyMs,
  };
}

export async function executeSetup(
  operation: Extract<SystemAgentOperation, { kind: "setup" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  const overview = await loadOverviewForOperation(opts.deps);
  const setupModel = (overview.defaultModel ?? overview.setupModel)?.trim();
  const modelRole = overview.defaultModel ? "default" : "setup";
  if (!setupModel) {
    throw new Error(
      "OpenClaw setup requires working inference first. Run `openclaw onboard` on the machine running OpenClaw to configure and verify a default model, then start OpenClaw again.",
    );
  }
  const requestedModel = operation.model?.trim();
  if (requestedModel && requestedModel !== setupModel) {
    throw new Error(
      `OpenClaw setup will preserve the verified ${modelRole} model ${setupModel}. Staging, live-testing, and saving a different inference route is \`openclaw onboard\` on the machine running OpenClaw.`,
    );
  }
  if (!opts.approved) {
    const message = [
      formatSystemAgentPersistentPlan(operation, opts.operatorApprovalOnly),
      `Model choice: keep verified ${modelRole} ${setupModel}.`,
    ].join("\n");
    runtime.log(message);
    return { applied: false, message };
  }
  const verified = await verifyCurrentSetupInference(runtime, opts.deps);
  if (requestedModel && requestedModel !== verified.modelRef) {
    throw new Error(
      `The verified default model is now ${verified.modelRef}, not ${requestedModel}. Review the current route, or run \`openclaw onboard\` on the machine running OpenClaw, before retrying setup.`,
    );
  }
  return await applyPersistentOperation({
    auditOperation: "openclaw.setup",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const applySetup =
        ctx.deps?.applySetup ?? (await import("./setup-apply.js")).applySystemAgentSetup;
      const surface = ctx.deps?.setupSurface ?? "cli";
      const recovery =
        surface === "cli"
          ? await (await import("./setup-recovery.js")).loadLocalSetupRecovery(operation.workspace)
          : undefined;
      const workspace =
        recovery?.workspace ?? resolveUserPath(operation.workspace ?? process.cwd());
      // Cover injected implementations at entry and carry the same synchronous
      // authority into production setup's workspace and config owners.
      const applied = await ctx.commit(() =>
        applySetup(
          {
            workspace,
            ...(operation.agentName ? { firstAgent: { name: operation.agentName } } : {}),
            expectedInferenceRoute: verified.route,
            ...recovery?.applyOptions,
            surface,
            runtime: ctx.runtime,
          },
          { beforePersistentApply: ctx.assertPersistentApply },
        ),
      );
      if (!applied.workspaceReady) {
        throw new Error("The workspace could not be prepared. Retry onboarding to finish setup.");
      }
      if (applied.gateway.status === "failed") {
        throw new Error(applied.gateway.error);
      }
      const after =
        (await recovery?.complete(applied.configPath, (effect) => ctx.commit(effect))) ??
        (await readConfigFileSnapshotLazy());
      ctx.runtime.log(`Updated ${after.path || applied.configPath || "config"}`);
      for (const line of applied.lines) {
        ctx.runtime.log(line);
      }
      ctx.runtime.log(
        `${modelRole === "default" ? "Default" : "Setup"} model: ${verified.modelRef} (verified and kept)`,
      );
      return {
        summary: "Bootstrapped setup workspace",
        bootstrapPending: applied.bootstrapPending,
        configPath: after.path || applied.configPath,
        details: {
          workspace,
          model: verified.modelRef,
          modelSource: `live-verified ${modelRole} model`,
          inferenceLatencyMs: verified.latencyMs,
        },
      };
    },
  });
}

export async function executeSetDefaultModel(
  operation: Extract<SystemAgentOperation, { kind: "set-default-model" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  return await applyPersistentOperation({
    auditOperation: "config.setDefaultModel",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const { mutateConfigFile, readConfigFileSnapshot } = await import("../config/config.js");
      const { applySystemAgentModelSelection, createSystemAgentModelSelectionUpdater } =
        await import("./setup-model-selection.js");
      const targetAgentId = operation.agentId;
      const snapshot = await readConfigFileSnapshot();
      // Route projection and the live probes below all take the same optional
      // agent scope, so a per-agent selection is verified against that agent's
      // route with the exact rigor the default route gets.
      const projectRoute = (config: OpenClawConfig) => projectInferenceRoute(config, targetAgentId);
      const stagedConfig = await applySystemAgentModelSelection({
        config: snapshot.sourceConfig,
        model: operation.model,
        ...(targetAgentId ? { targetAgentId } : {}),
      });
      const beforeRoute = await projectRoute(snapshot.sourceConfig);
      const verifiedRoute = await projectRoute(stagedConfig);
      const verifyInferenceConfig =
        ctx.deps?.verifyInferenceConfig ??
        (await import("./setup-inference.js")).verifySetupInferenceConfig;
      const initialVerification = await verifyInferenceConfig({
        config: stagedConfig,
        runtime: ctx.runtime,
        requireExecutionOwner: true,
        ...(targetAgentId ? { agentId: targetAgentId } : {}),
      });
      if (!initialVerification.ok) {
        throw new Error(
          `The requested model failed a live inference test, so the current default model was not changed. ${initialVerification.error} Fix provider authentication or model access, then retry.`,
        );
      }
      const verifiedModelRef = verifiedRoute.route?.modelLabel;
      if (!verifiedModelRef || initialVerification.modelRef !== verifiedModelRef) {
        throw new Error(
          "The live inference test did not verify the exact model route that would be saved, so the current default model was not changed. Review model aliases and runtime routing, then retry.",
        );
      }
      let persistedVerification = initialVerification;
      let persistedBinding: SystemAgentVerifiedInferenceBinding | undefined;
      let selectedRouteForCommit = verifiedRoute;
      const selectModel = await createSystemAgentModelSelectionUpdater({
        model: operation.model,
        ...(targetAgentId ? { targetAgentId } : {}),
      });
      const result = await mutateConfigFile({
        base: "source",
        writeOptions: {
          auditOrigin: "system-agent",
          ...(ctx.assertPersistentApply
            ? { assertConfigPathForWrite: ctx.assertPersistentApply }
            : {}),
          preCommitRuntimePreflight: async (sourceConfig) => {
            const commitRoute = await projectRoute(sourceConfig);
            if (!sameDefaultInferenceRoute(commitRoute, selectedRouteForCommit)) {
              throw new Error(
                "The selected inference route changed while preparing the config write, so the requested model was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            ctx.assertPersistentApply?.();
            let latestBinding: SystemAgentVerifiedInferenceBinding | undefined;
            const latestVerification = await verifyInferenceConfig({
              config: sourceConfig,
              runtime: ctx.runtime,
              requireExecutionOwner: true,
              ...(targetAgentId ? { agentId: targetAgentId } : {}),
              ...(opts.onVerifiedInferenceChanged
                ? {
                    onVerifiedExecution: (binding: SystemAgentVerifiedInferenceBinding) => {
                      latestBinding = binding;
                    },
                  }
                : {}),
            });
            if (!latestVerification.ok) {
              throw new Error(
                `The requested model no longer passes live inference at the config commit boundary, so it was not saved. ${latestVerification.error} Review concurrent configuration changes and retry.`,
              );
            }
            if (latestVerification.modelRef !== commitRoute.route?.modelLabel) {
              throw new Error(
                "The final live inference test did not verify the exact model route at the config commit boundary, so the requested model was not saved. Review model aliases and runtime routing, then retry.",
              );
            }
            if (opts.onVerifiedInferenceChanged && !latestBinding) {
              throw new Error(
                "The final live inference test did not return a reusable session binding, so the requested model was not saved. Retry the model change.",
              );
            }
            // The live probe can outlive the original OpenClaw authority.
            // Re-check it last, immediately before the writer crosses to disk.
            ctx.assertPersistentApply?.();
            persistedVerification = latestVerification;
            persistedBinding = latestBinding;
          },
        },
        mutate: async (cfg) => {
          // Verification may take time. Preserve unrelated edits, but never
          // combine the passing result with a concurrently changed route.
          const currentRoute = await projectRoute(cfg);
          if (!sameDefaultInferenceRoute(currentRoute, beforeRoute)) {
            throw new Error(
              "The default-agent inference route changed during verification, so the requested model was not saved. Review the current model/auth/runtime settings and retry.",
            );
          }
          const selected = selectModel(cfg);
          const selectedRoute = await projectRoute(selected);
          if (selectedRoute.route?.modelLabel !== verifiedModelRef) {
            throw new Error(
              "The model selection no longer resolves to the exact model that passed live inference. Review the current model/auth/runtime settings and retry.",
            );
          }
          // Unrelated concurrent edits can change how the selected model is
          // represented. Bind the commit gate to this deterministic projection;
          // the final live probe below verifies these exact bytes before write.
          selectedRouteForCommit = selectedRoute;
          cfg.agents = selected.agents;
        },
      });
      if (persistedBinding) {
        opts.onVerifiedInferenceChanged?.(persistedBinding);
      }
      ctx.runtime.log(`Updated ${result.path}`);
      ctx.runtime.log(
        targetAgentId
          ? `Agent ${targetAgentId} model: ${persistedVerification.modelRef}`
          : `Default model: ${persistedVerification.modelRef}`,
      );
      return {
        summary: targetAgentId
          ? `Set agent ${targetAgentId} model to ${operation.model}`
          : `Set default model to ${operation.model}`,
        configPath: result.path,
        details: {
          ...(targetAgentId ? { agentId: targetAgentId } : {}),
          requestedModel: operation.model,
          effectiveModel: persistedVerification.modelRef,
          inferenceVerified: true,
          inferenceLatencyMs: persistedVerification.latencyMs,
        },
      };
    },
  });
}

/**
 * Uninstalling the plugin that provides the active default inference route
 * would break the very session driving the change, so that case stays a
 * terminal-only operation. Every other plugin is uninstallable behind the
 * standard approval gate — matching what the operator can do from the UI/CLI.
 */
export async function isPluginBackingDefaultInferenceRoute(pluginId: string): Promise<boolean> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return true;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  const route = (await projectDefaultInferenceRoute(config ?? {})).route;
  if (!route) {
    return false;
  }
  // The route's execution owners are the provider plus whichever runtime
  // component executes it (embedded harness override or the resolved model
  // runtime policy, e.g. a CLI-backend harness plugin) — removing any of them
  // breaks the session driving this change.
  const { resolveModelRuntimePolicy } = await import("../agents/model-runtime-policy.js");
  const runtimePolicyId = resolveModelRuntimePolicy({
    config,
    provider: route.provider,
    modelId: route.model,
    agentId: route.agentId,
  }).policy?.id;
  const normalizedPluginId = pluginId.trim().toLowerCase();
  const components = [
    route.provider,
    runtimePolicyId,
    route.runner === "embedded" ? route.agentHarnessRuntimeOverride : undefined,
  ]
    .map((component) => component?.trim().toLowerCase())
    .filter((component): component is string => Boolean(component));
  // Same-name convention covers components with no resolvable plugin metadata.
  if (components.includes(normalizedPluginId)) {
    return true;
  }
  const { resolveOwningPluginIdsForProviderRef } = await import("../plugins/providers.js");
  return components.some((component) =>
    (resolveOwningPluginIdsForProviderRef({ provider: component, config }) ?? []).some(
      (owner) => owner.trim().toLowerCase() === normalizedPluginId,
    ),
  );
}
