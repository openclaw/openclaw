import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isUserModelAuthProfileId } from "../../../state/user-model-account-id.js";
import { resolveAgentDir } from "../../agent-scope-config.js";
import { ensureAuthProfileStoreWithoutExternalProfilesAsync } from "../../auth-profiles.js";
import { resolveRunEntryCliRuntime } from "../../embedded-agent-runner/run-entry-runtime.js";
import { createModelAuthAvailabilityResolver } from "../../model-auth-availability.js";
import type { ModelAuthAvailabilityEvaluation } from "../../model-auth-availability.types.js";
import {
  getPreparedModelCatalogOwnerSnapshot,
  materializePreparedModelCatalogOwner,
} from "../../prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "../../prepared-model-runtime-auth.js";
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
): Pick<SpawnBillingRoute, "resolvedAuth" | "resolvedAuthProfile"> {
  if (evaluation.availability === false) {
    return { resolvedAuth: "unavailable" };
  }
  if (evaluation.availability !== true) {
    return { resolvedAuth: "unknown" };
  }
  const profile = evaluation.selectedProfileId;
  const mode = evaluation.selectedAuthMode?.replaceAll("_", "-");
  const resolvedAuth: SpawnResolvedAuth =
    (evaluation.runtimeAuth && !profile) || mode === "native-command"
      ? "native"
      : mode === "api-key" || mode === "oauth" || mode === "token"
        ? mode
        : "unknown";
  return {
    resolvedAuth,
    // Same masking as session_status: never echo a personal account locator.
    ...(profile
      ? { resolvedAuthProfile: isUserModelAuthProfileId(profile) ? "personal account" : profile }
      : {}),
  };
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
  // Same order as the run seam: a CLI backend owns the turn before harness selection.
  const cli = resolveRunEntryCliRuntime({
    config: cfg,
    provider,
    model,
    agentId,
    authProfileId: params.authProfileId,
  });
  const resolvedRuntime = cli.useCliExecution
    ? cli.cliExecutionProvider
    : // Execution mode applies the implicit-runtime fallback the turn itself takes.
      resolveEffectiveAgentRuntime({ cfg, provider, modelId: model, agentId, mode: "execution" });
  try {
    // Borrow the prepared owner like session_status: its credential modes carry CLI runtimes'
    // native logins, which the profile store alone cannot see. It never starts discovery.
    const prepared = getPreparedModelCatalogOwnerSnapshot({
      config: cfg,
      agentId,
      agentDir,
      workspaceDir: params.workspaceDir,
      readOnly: true,
    });
    const owner = prepared ? materializePreparedModelCatalogOwner(prepared) : undefined;
    const authStore =
      (owner && getPreparedModelRuntimeAuthStore(owner)) ??
      (await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir, {
        allowKeychainPrompt: false,
      }));
    const evaluation = createModelAuthAvailabilityResolver({
      cfg,
      agentId,
      agentDir,
      workspaceDir: params.workspaceDir,
      authStore,
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
    });
    return { resolvedRuntime, ...describeSpawnAuth(evaluation) };
  } catch (error) {
    log.warn(`spawn billing route unresolved for ${provider}/${model}: ${String(error)}`);
    return { resolvedRuntime, resolvedAuth: "unknown" };
  }
}
