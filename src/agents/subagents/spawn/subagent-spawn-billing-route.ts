import type { ModelApi } from "../../../config/model-config-vocabulary.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isUserModelAuthProfileId } from "../../../state/user-model-account-id.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agent-runtime-id.js";
import { resolveAgentDir } from "../../agent-scope-config.js";
import { ensureAuthProfileStoreWithoutExternalProfilesAsync } from "../../auth-profiles.js";
import { resolveRunEntryCliRuntime } from "../../embedded-agent-runner/run-entry-runtime.js";
import { createModelAuthAvailabilityResolver } from "../../model-auth-availability.js";
import type { ModelAuthAvailabilityEvaluation } from "../../model-auth-availability.types.js";
import { findModelInCatalog } from "../../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../model-catalog.types.js";
import {
  getPreparedModelCatalogOwnerSnapshot,
  materializePreparedModelCatalogOwner,
} from "../../prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthMaterializations,
  getPreparedModelRuntimeAuthStore,
} from "../../prepared-model-runtime-auth.js";
import { resolveEffectiveAgentRuntime } from "../../thinking-runtime.js";

const log = createSubsystemLogger("agents/spawn-billing-route");

/** `native` is the runtime's own login; `unavailable` means the selected route has no credential. */
export type SpawnResolvedAuth =
  | "api-key"
  | "oauth"
  | "token"
  | "native"
  | "unavailable"
  | "unknown";

export type SpawnBillingRoute = {
  /** Concrete runtime the child turn resolves to, for example `openclaw` or `claude-cli`. */
  resolvedRuntime: string;
  resolvedAuth: SpawnResolvedAuth;
  /** Auth profile that supplies the credential; personal account ids read `personal account`. */
  resolvedAuthProfile?: string;
};

/** Maps the credential owner's evaluation onto the documented receipt values. */
export function describeSpawnAuth(
  evaluation: Pick<
    ModelAuthAvailabilityEvaluation,
    "availability" | "selectedAuthMode" | "selectedProfileId" | "runtimeAuth"
  >,
  options: { cliBackend?: boolean } = {},
): Pick<SpawnBillingRoute, "resolvedAuth" | "resolvedAuthProfile"> {
  if (evaluation.availability === false) {
    return { resolvedAuth: "unavailable" };
  }
  if (evaluation.availability !== true) {
    return { resolvedAuth: "unknown" };
  }
  const profile = evaluation.selectedProfileId;
  const mode = evaluation.selectedAuthMode?.replaceAll("_", "-");
  // Same order as session_status. A harness login names its credential kind (the Codex login
  // probe reports api-key, oauth or token from `codex login status`), so that kind wins. A CLI
  // backend owns its login: session_status labels it native, and its probe reports one fixed
  // mode for every login method, so that mode is not evidence of the credential kind.
  const kindless = evaluation.runtimeAuth && !profile && options.cliBackend;
  const resolvedAuth: SpawnResolvedAuth =
    !kindless && (mode === "api-key" || mode === "oauth" || mode === "token")
      ? mode
      : evaluation.runtimeAuth || mode === "native-command"
        ? "native"
        : "unknown";
  return {
    resolvedAuth,
    // Same masking as session_status: never echo a personal account locator.
    ...(profile
      ? { resolvedAuthProfile: isUserModelAuthProfileId(profile) ? "personal account" : profile }
      : {}),
  };
}

type SpawnModelTransport = { api?: ModelApi; baseUrl?: string };

/** The transport execution passes to harness selection: catalog first, then authored config. */
function resolveSpawnModelTransport(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  owner?: { modelCatalog?: { entries: readonly ModelCatalogEntry[] } };
}): SpawnModelTransport {
  const entry = params.owner?.modelCatalog
    ? findModelInCatalog(params.owner.modelCatalog.entries, params.provider, params.model)
    : undefined;
  const configured = params.cfg.models?.providers?.[params.provider];
  const definition = configured?.models?.find((candidate) => candidate.id === params.model);
  const api = entry?.api ?? definition?.api ?? configured?.api;
  const baseUrl = entry?.baseUrl ?? configured?.baseUrl;
  return {
    ...(api ? { api } : {}),
    ...(typeof baseUrl === "string" && baseUrl ? { baseUrl } : {}),
  };
}

/** Same order as the run seam: a CLI backend owns the turn, then harness selection by transport. */
async function resolveSpawnRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  authProfileId?: string;
  transport: SpawnModelTransport;
}): Promise<{ id: string; cliBackend: boolean }> {
  const { cfg, agentId, provider, model } = params;
  const cli = resolveRunEntryCliRuntime({
    config: cfg,
    provider,
    model,
    agentId,
    authProfileId: params.authProfileId,
  });
  if (cli.useCliExecution) {
    return { id: cli.cliExecutionProvider, cliBackend: true };
  }
  try {
    // Lazy: harness selection reaches agent tool assembly, which imports sessions_spawn.
    const { selectAgentHarness } = await import("../../harness/selection.js");
    const harness = selectAgentHarness({
      provider,
      modelId: model,
      config: cfg,
      agentId,
      modelProvider: params.transport,
    });
    return { id: harness.id, cliBackend: false };
  } catch {
    // Selection can refuse a route the turn would also refuse; report the configured runtime.
    const id = resolveEffectiveAgentRuntime({
      cfg,
      provider,
      modelId: model,
      modelApi: params.transport.api,
      modelBaseUrl: params.transport.baseUrl,
      agentId,
      mode: "execution",
    });
    return { id, cliBackend: false };
  }
}

type PreparedOwner = ReturnType<typeof materializePreparedModelCatalogOwner>;

/**
 * Evaluates the child's credential through the prepared decision owner that session_status and
 * models.list use, so every prepared input (native logins, synthetic auth refs, native-command
 * and plugin-owned auth, materializations, account listings) applies exactly as it does there.
 */
async function evaluatePreparedSpawnAuth(params: {
  owner: PreparedOwner;
  preparedAuthStore: NonNullable<ReturnType<typeof getPreparedModelRuntimeAuthStore>>;
  agentId: string;
  provider: string;
  model: string;
  runtimeId: string;
  authProfileId?: string;
  transport: SpawnModelTransport;
}) {
  const { owner, provider, model, runtimeId } = params;
  // Lazy like harness selection: the decision owner reaches agent assembly modules.
  const { prepareModelCatalogDecisions } = await import("../../model-catalog-decisions.js");
  const decisions = await prepareModelCatalogDecisions({
    cfg: owner.config,
    agentId: params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: params.preparedAuthStore,
    preparedRuntimeAuthModes: owner.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    ...(params.authProfileId
      ? { preferredProfileId: params.authProfileId, pinnedProfileId: params.authProfileId }
      : {}),
    profileProvider: provider,
  });
  const entry = findModelInCatalog(decisions.snapshot.entries, provider, model);
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => row.provider === provider && row.id === model,
  );
  const host = decisions.evaluateEntry(
    entry ?? { provider, id: model, ...params.transport },
    variants.length ? variants : entry ? [entry] : undefined,
    runtimeId,
  );
  return entry ? decisions.evaluateNative(entry, host, runtimeId) : host;
}

/**
 * Projects the runtime and credential owners for a spawned child so the receipt names its
 * billing route for the primary model. Like session_status, it reads configured profiles and
 * environment credentials, not externally synced CLI profiles. The run seam still decides at
 * execution and may fall back to another model; this is display only, so an evaluation
 * failure reports `unknown` instead of failing the spawn.
 */
export async function resolveSpawnBillingRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  authProfileId?: string;
}): Promise<SpawnBillingRoute> {
  const { cfg, agentId, provider, model } = params;
  const agentDir = resolveAgentDir(cfg, agentId);
  // Borrow the prepared owner like session_status: its catalog carries the model's transport
  // and its credential modes carry CLI runtimes' native logins. It never starts discovery.
  let owner: ReturnType<typeof materializePreparedModelCatalogOwner> | undefined;
  try {
    const prepared = getPreparedModelCatalogOwnerSnapshot({
      config: cfg,
      agentId,
      agentDir,
      workspaceDir: params.workspaceDir,
      readOnly: true,
    });
    owner = prepared ? materializePreparedModelCatalogOwner(prepared) : undefined;
  } catch (error) {
    log.warn(
      `spawn billing route without prepared facts for ${provider}/${model}: ${String(error)}`,
    );
  }
  const transport = resolveSpawnModelTransport({ cfg, provider, model, owner });
  const runtime = await resolveSpawnRuntime({ ...params, transport });
  const resolvedRuntime = runtime.id;
  try {
    const preparedAuthStore = owner && getPreparedModelRuntimeAuthStore(owner);
    const evaluation =
      owner && preparedAuthStore
        ? await evaluatePreparedSpawnAuth({
            owner,
            preparedAuthStore,
            agentId,
            provider,
            model,
            runtimeId: resolvedRuntime,
            authProfileId: params.authProfileId,
            transport,
          })
        : createModelAuthAvailabilityResolver({
            cfg,
            agentId,
            agentDir,
            workspaceDir: params.workspaceDir,
            authStore: await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir, {
              allowKeychainPrompt: false,
            }),
            externalCliProviderIds: [],
            ...(owner
              ? {
                  metadataSnapshot: owner.metadataSnapshot,
                  preparedRuntimeAuthModes: owner.authModes,
                }
              : {}),
          }).evaluateRuntimeModelAuth(provider, {
            modelId: model,
            runtimeId: resolvedRuntime,
            pinnedProfileId: params.authProfileId,
            ...transport,
          });
    // Without prepared facts a runtime's own login is invisible, so a missing credential
    // is not evidence that the child has none.
    if (
      !preparedAuthStore &&
      evaluation.availability === false &&
      resolvedRuntime !== OPENCLAW_AGENT_RUNTIME_ID
    ) {
      return { resolvedRuntime, resolvedAuth: "unknown" };
    }
    return {
      resolvedRuntime,
      ...describeSpawnAuth(evaluation, { cliBackend: runtime.cliBackend }),
    };
  } catch (error) {
    log.warn(`spawn billing route unresolved for ${provider}/${model}: ${String(error)}`);
    return { resolvedRuntime, resolvedAuth: "unknown" };
  }
}
