/** Lazy preparation runtimes and session lifecycle helpers for cron runs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { hasAnyAuthProfileStoreSourceAsync } from "../../agents/auth-profiles/source-check.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
  CronStoredJob,
} from "../types.js";
import type { CronSessionRowWriter, MutableCronSession } from "./run-session-state.js";
import { logWarn } from "./run.runtime.js";
import type { CronLaneWaitCallback, RunCronAgentTurnResult } from "./run.types.js";

export type RunCronAgentTurnParams = {
  admissionSource?: import("../../agents/admitted-run-context.js").AdmittedRunContext["admissionSource"];
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronStoredJob;
  /** Trusted caller classification; stored jobs default to cron, not their payload or audit ingress. */
  trigger?: "cron" | "event";
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: CronLaneWaitCallback;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  executionIdentity?: import("../service/state.js").CronExecutionIdentityAdmission;
};

export type WithRunSession = (
  result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
) => RunCronAgentTurnResult;

const sessionAccessorRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);
const cronAuthProfileRuntimeLoader = createLazyImportLoader(
  () => import("./run-auth-profile.runtime.js"),
);
async function loadSessionAccessorRuntime() {
  return await sessionAccessorRuntimeLoader.load();
}

export function createCronSessionRowWriter(params: {
  agentId: string;
  agentSessionKey: string;
}): CronSessionRowWriter {
  const { agentId, agentSessionKey } = params;
  let baseSessionMaintenanceStarted = false;
  return async ({ storePath, sessionKey, operation, resetBoundary, assertCommitAllowed }) => {
    if (resetBoundary) {
      const [{ applySessionEntryLifecycleMutation }, { projectCronSessionEntry }] =
        await Promise.all([
          loadSessionAccessorRuntime(),
          import("../../config/sessions/session-entry-patch-operation.js"),
        ]);
      let entry = operation.next;
      await applySessionEntryLifecycleMutation({
        activeSessionKey: sessionKey,
        agentId,
        storePath,
        upserts: [
          {
            sessionKey,
            resetBoundary,
            buildEntry: ({ currentEntry }) =>
              (entry = projectCronSessionEntry(operation, currentEntry)),
          },
        ],
        skipMaintenance: true,
      });
      return entry;
    }
    const { applySessionEntryOperation } =
      await import("../../config/sessions/session-accessor.sqlite-entry.js");
    const entry = await applySessionEntryOperation({ storePath, sessionKey, agentId }, operation, {
      fallbackEntry: operation.next,
      replaceEntry: true,
      // The maintenance owner follows later writes through its receipt subscription.
      skipMaintenance: baseSessionMaintenanceStarted || sessionKey !== agentSessionKey,
      workerGuard: { assertCurrent: assertCommitAllowed },
    });
    if (sessionKey === agentSessionKey) {
      baseSessionMaintenanceStarted = true;
    }
    return entry;
  };
}

function hasConfiguredAuthProfiles(cfg: OpenClawConfig): boolean {
  return (
    Boolean(cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) ||
    Boolean(cfg.auth?.order && Object.keys(cfg.auth.order).length > 0)
  );
}

/**
 * Resolves the run's auth profile, skipping the lazy runtime entirely when no
 * override, configured profile, or store source exists for it to find. Auth
 * resolution may mutate session state, so it uses the store and key that
 * persistence will write.
 */
export async function resolveCronAuthSelection(params: {
  agentId: string;
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  configuredProfileId?: string;
  agentDir: string;
  cronSession: MutableCronSession;
  sessionKey: string;
  isNewSession: boolean;
}) {
  const hasSessionOverride = Boolean(params.cronSession.sessionEntry.authProfileOverride?.trim());
  if (
    !hasSessionOverride &&
    !hasConfiguredAuthProfiles(params.cfg) &&
    !(await hasAnyAuthProfileStoreSourceAsync(params.agentDir))
  ) {
    return undefined;
  }
  const runtime = await cronAuthProfileRuntimeLoader.load();
  return await runtime.resolveSessionAuthSelection({
    agentId: params.agentId,
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    ...(params.configuredProfileId ? { configuredProfileId: params.configuredProfileId } : {}),
    agentDir: params.agentDir,
    sessionEntry: params.cronSession.sessionEntry,
    sessionStore: params.cronSession.store,
    sessionKey: params.sessionKey,
    storePath: params.cronSession.storePath,
    isNewSession: params.isNewSession,
  });
}

export async function retireRolledCronSessionMcpRuntime(params: {
  job: CronJob;
  cronSession: MutableCronSession;
}) {
  if (params.job.sessionTarget === "isolated") {
    return;
  }
  const previousSessionId = normalizeOptionalString(params.cronSession.previousSessionId);
  const currentSessionId = normalizeOptionalString(params.cronSession.sessionEntry.sessionId);
  if (!previousSessionId || previousSessionId === currentSessionId) {
    return;
  }
  await retireSessionMcpRuntime({
    sessionId: previousSessionId,
    reason: "cron-session-rollover",
    onError: (error, sessionId) => {
      logWarn(
        `[cron:${params.job.id}] Failed to dispose retired bundle MCP runtime for session ${sessionId}: ${String(error)}`,
      );
    },
  });
}
