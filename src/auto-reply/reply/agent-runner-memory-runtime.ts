import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { exceedsContextWindow } from "../../agents/context-pressure.js";
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
import { isExplicitChatFork } from "../../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemoryFlushRunParams } from "./agent-runner-memory.types.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";

/** Copied chat history is searchable storage, not an estimate of the next runnable prompt. */
export function shouldEstimatePreflightTranscript(
  entry: SessionEntry,
  key: string | undefined,
  runtimeId: string,
  freshTokens: number | undefined,
): boolean {
  return (
    freshTokens === undefined &&
    !(
      runtimeId === "openclaw" &&
      key !== undefined &&
      entry.forkSource !== undefined &&
      entry.forkSource.entryId === undefined &&
      isExplicitChatFork(key, entry.createdVia, entry.spawnDepth)
    )
  );
}

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

/**
 * Maintenance that still fits waits for the attempt's request boundary, which
 * summarizes from the warm prompt cache. A prompt that cannot fit compacts here.
 */
export async function defersTokenCompactionToRequestBoundary(
  run: FollowupRun["run"],
  tokenCount: number | undefined,
  contextWindowTokens: number,
): Promise<boolean> {
  if (exceedsContextWindow(tokenCount, contextWindowTokens)) {
    return false;
  }
  // Lazy: reply maintenance must not load the attempt runtime graph.
  const { requestBoundaryOwnsCompaction } =
    await import("../../agents/embedded-agent-runner/run/request-boundary-compaction.js");
  // A configured context engine may own compaction; it keeps reply-level maintenance.
  const contextEngine = run.config.plugins?.slots?.contextEngine?.trim();
  return (
    (!contextEngine || contextEngine === "legacy") &&
    requestBoundaryOwnsCompaction({
      config: run.config,
      compactionEnabled: run.config.agents?.defaults?.compaction?.enabled !== false,
    })
  );
}

/** Points the follow-up run and its queued work at the compacted session. */
export function adoptCompactedFollowupSession(
  params: {
    followupRun: FollowupRun;
    sessionKey?: string;
    onSessionIdChanged?: (sessionId: string) => void;
  },
  sessionId: string,
): void {
  const previousSessionId = params.followupRun.run.sessionId;
  params.followupRun.run.sessionId = sessionId;
  params.onSessionIdChanged?.(sessionId);
  const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
  if (queueKey) {
    params.followupRun.run.sessionFile = queueKey;
    refreshQueuedFollowupSession({
      key: queueKey,
      previousSessionId,
      nextSessionId: sessionId,
      nextSessionFile: queueKey,
    });
  }
}
