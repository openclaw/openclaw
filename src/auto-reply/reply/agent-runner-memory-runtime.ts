import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { resolveModelContextTokenProjection } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { resolveModelContextWindowProfile } from "../../agents/model-context-window.js";
import { isCliRuntimeAliasForProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { withSandboxRuntimeStatusInWorker } from "../../agents/sandbox/runtime-status.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveProjectedSessionContextTokens } from "../../config/sessions/context-token-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemoryFlushRunParams } from "./agent-runner-memory.types.js";
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

/** One source classification supplies both workspace and persistence-tool eligibility. */
export async function resolveMemoryFlushSandbox(
  params: Pick<
    MemoryFlushRunParams,
    "cfg" | "followupRun" | "sessionKey" | "runtimePolicySessionKey"
  >,
  assertCurrent: () => void,
) {
  if (!params.sessionKey) {
    return { writable: true, toolPolicy: undefined };
  }
  return await withSandboxRuntimeStatusInWorker(
    {
      cfg: params.cfg,
      agentId: params.followupRun.run.agentId,
      sessionKey: params.sessionKey,
      classificationSessionKey:
        params.runtimePolicySessionKey ?? params.followupRun.run.runtimePolicySessionKey,
    },
    { env: process.env, cwd: process.cwd(), assertCurrent },
    async ({ sandboxed, toolPolicy, workspaceAccess: access, classificationAgentId: agentId }) => ({
      writable:
        !sandboxed ||
        (access ?? resolveSandboxConfigForAgent(params.cfg, agentId).workspaceAccess) === "rw",
      toolPolicy: sandboxed ? toolPolicy : undefined,
    }),
  );
}

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
  {
    cfg,
    followupRun,
    defaultModel,
    sessionEntry,
  }: FollowupRuntimeParams & {
    defaultModel: string;
    sessionEntry?: SessionEntry;
  },
  runtimeId: string,
): number {
  const { provider } = followupRun.run;
  const model = followupRun.run.model ?? defaultModel;
  const catalogModel = findModelInCatalog(
    (followupRun.run.thinkingCatalog ?? []).filter((entry) =>
      runtimeId === "openclaw" ? !entry.nativeRuntime : entry.nativeRuntime === runtimeId,
    ),
    provider,
    model,
  );
  const matchingSessionEntry =
    sessionEntry?.sessionId === followupRun.run.sessionId ? sessionEntry : undefined;
  const profile = resolveModelContextWindowProfile({
    catalogEntry: catalogModel,
    selected: matchingSessionEntry?.contextWindow,
  });
  const projection = resolveModelContextTokenProjection({
    cfg,
    provider,
    modelProvider: provider,
    model,
    modelContextWindow:
      profile.contextWindow || catalogModel?.contextWindowSource !== "synthetic"
        ? profile.contextTokens
        : undefined,
    modelContextTokens: catalogModel?.contextTokens,
    fallbackContextTokens: catalogModel?.contextWindow,
    allowAsyncLoad: false,
    // Maintenance consumes this run's admitted catalog, never another route's cache.
    allowCacheLookup: false,
  });
  const projected =
    resolveProjectedSessionContextTokens({
      entry:
        matchingSessionEntry?.authProfileOverride === followupRun.run.authProfileId
          ? matchingSessionEntry
          : undefined,
      provider,
      model,
      agentHarnessId: runtimeId,
      authoredContextTokens: projection.authoredContextTokens,
      resolvedContextTokens: projection.contextTokens,
    }) ?? DEFAULT_CONTEXT_TOKENS;
  return profile.contextWindow && profile.contextTokens
    ? Math.min(projected, profile.contextTokens)
    : projected;
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
