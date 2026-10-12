import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { isCliRuntimeAliasForProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../../agents/openai-routing.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContextTokens } from "./model-selection-context.js";
import type { FollowupRun } from "./queue.js";

type FollowupRuntimeParams = {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: Pick<
    SessionEntry,
    | "agentHarnessId"
    | "agentRuntimeOverride"
    | "modelSelectionLocked"
    | "pluginOwnerId"
    | "sessionId"
  >;
  sessionKey?: string;
  agentHarnessId?: string;
};

export function followupUsesCliRuntime(params: FollowupRuntimeParams, runtimeId: string): boolean {
  const provider = params.followupRun.run.provider;
  if (params.agentHarnessId) {
    return isCliRuntimeAliasForProvider({
      provider,
      runtime: params.agentHarnessId,
      cfg: params.cfg,
    });
  }
  if (isCliProvider(provider, params.cfg)) {
    return true;
  }
  return [resolvePersistedSessionRuntimeId(params.sessionEntry), runtimeId].some((runtime) =>
    isCliRuntimeAliasForProvider({ provider, runtime, cfg: params.cfg }),
  );
}

export function resolveFollowupAgentRuntimeId(params: FollowupRuntimeParams): string {
  if (params.agentHarnessId) {
    return params.agentHarnessId;
  }
  const matchingSessionEntry =
    params.sessionEntry?.sessionId === params.followupRun.run.sessionId
      ? params.sessionEntry
      : undefined;
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model,
    agentId: params.followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg),
    // Model/runtime selection belongs to execution; sandbox policy has its own classification key.
    sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
    sessionEntry: matchingSessionEntry,
  });
}

export function followupOwnsNativeCompaction(
  params: FollowupRuntimeParams,
  runtimeId: string,
): boolean {
  // Backends that persist resumable native transcripts must remain the sole
  // compaction owner; OpenClaw maintenance would corrupt that runtime state.
  return (
    resolveCliBackendConfig(runtimeId, params.cfg, {
      agentId: params.followupRun.run.agentId,
    })?.ownsNativeCompaction === true
  );
}

export function resolveFollowupContextTokens(
  { cfg, followupRun, defaultModel }: FollowupRuntimeParams & { defaultModel: string },
  runtimeId: string,
): number {
  const { provider } = followupRun.run;
  const model = followupRun.run.model ?? defaultModel;
  const catalogModel = findModelInCatalog(followupRun.run.thinkingCatalog ?? [], provider, model);
  return resolveContextTokens({
    cfg,
    provider: resolveContextConfigProviderForRuntime({ provider, runtimeId, config: cfg }),
    model,
    modelContextWindow: catalogModel?.contextWindow,
    modelContextTokens: catalogModel?.contextTokens,
  });
}

export async function defersTokenCompactionToChatGPTBoundary(
  run: FollowupRun["run"],
): Promise<boolean> {
  const [
    { getPreparedRuntimeAuthProfileStoreSnapshot },
    { prepareAgentRuntimeAuth },
    { resolvePreparedExtraParams },
    { isChatGPTV2CompactionEligible },
  ] = await Promise.all([
    import("../../agents/auth-profiles.js"),
    import("../../agents/runtime-plan/prepare-auth.js"),
    import("../../agents/embedded-agent-runner/extra-params.js"),
    import("../../agents/embedded-agent-runner/run/chatgpt-v2-compaction.js"),
  ]);
  // Reuse the attempt's route planner with lifecycle-published metadata only.
  // Maintenance must not load secrets or refresh credentials.
  let route;
  try {
    route = prepareAgentRuntimeAuth({
      provider: run.provider,
      modelId: run.model,
      config: run.config,
      agentId: run.agentId,
      agentDir: run.agentDir,
      workspaceDir: run.workspaceDir,
      authProfileStore: getPreparedRuntimeAuthProfileStoreSnapshot(run.agentDir),
      sessionAuthProfileId: run.authProfileId,
      sessionAuthProfileSource: run.authProfileIdSource,
      harnessId: "openclaw",
    }).plan.modelRoute;
  } catch {
    // A missing or stale route snapshot retains ordinary reply maintenance.
    return false;
  }
  return (
    route !== undefined &&
    isChatGPTV2CompactionEligible({
      config: run.config,
      model: route,
      extraParams: resolvePreparedExtraParams({
        cfg: run.config,
        provider: run.provider,
        modelId: run.model,
        agentId: run.agentId,
        agentDir: run.agentDir,
        workspaceDir: run.workspaceDir,
      }),
      compactionEnabled: run.config.agents?.defaults?.compaction?.enabled !== false,
      // Native Responses always replays checkpoints, independent of credentials.
      compactionReplayEnabled: true,
    })
  );
}
