/** Lazy preparation runtimes and session lifecycle helpers for cron runs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import type { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { resolveBundledCliBackendAuthPolicy } from "../../agents/cli-runner/cli-backend-auth-policy.js";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import { bindConfiguredModelAuthProfileScope } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import type { CronIdleAdmissionWait } from "../service/state.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
  CronStoredJob,
} from "../types.js";
import type { CronSessionRowWriter, MutableCronSession } from "./run-session-state.js";
import { logWarn, resolveSessionRuntimeOverrideForProvider } from "./run.runtime.js";
import type { CronLaneWaitCallback, RunCronAgentTurnResult } from "./run.types.js";

export type RunCronAgentTurnParams = {
  /** The occurrence admitted by the cron service, or by a hook or join-intro caller. */
  occurrence: import("../scheduled-occurrence.js").ScheduledOccurrence;
  waitForIdle?: CronIdleAdmissionWait;
  assertCurrent?: () => void;
  admissionSource?: import("../../agents/admitted-run-context.js").AdmittedRunContext["admissionSource"];
  cfg: OpenClawConfig;
  /** Gateway-selected cron partition; standalone callers resolve it from config. */
  cronStorePath?: string;
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
  assertCurrent?: () => void;
}): CronSessionRowWriter {
  const { agentId, agentSessionKey } = params;
  let baseSessionMaintenanceStarted = false;
  return async ({ storePath, sessionKey, operation, resetBoundary, assertCommitAllowed }) => {
    const assertCurrent = () => {
      params.assertCurrent?.();
      assertCommitAllowed?.();
    };
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
        commitGuard: assertCurrent,
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
      workerGuard: { assertCurrent },
    });
    if (sessionKey === agentSessionKey) {
      baseSessionMaintenanceStarted = true;
    }
    return entry;
  };
}

type CronAuthSelection = Pick<
  NonNullable<Awaited<ReturnType<typeof resolveSessionAuthSelection>>>,
  "profileId" | "source" | "configuredPrimaryProvider"
>;

export function createCronLiveModelSelection(params: {
  provider: string;
  model: string;
  cfg: OpenClawConfig;
  sessionEntry: Parameters<typeof resolveSessionRuntimeOverrideForProvider>[0]["entry"];
  authSelection: CronAuthSelection | undefined;
}): LiveSessionModelSelection {
  const selection: LiveSessionModelSelection = {
    provider: params.provider,
    model: params.model,
    agentRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
      provider: params.provider,
      entry: params.sessionEntry,
      cfg: params.cfg,
    }),
    authProfileId: params.authSelection?.profileId,
    authProfileIdSource: params.authSelection?.source,
  };
  bindConfiguredModelAuthProfileScope(selection, params.authSelection?.configuredPrimaryProvider);
  return selection;
}

/**
 * The shared resolver validates explicit and matching default account selections
 * even without a credential store. Resolution may mutate session state, so it
 * uses the store and key that persistence will write.
 */
export async function resolveCronAuthSelection(params: {
  agentId: string;
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentRuntime: string;
  configuredProfileId?: string;
  configuredProfileIsDefault?: boolean;
  agentDir: string;
  cronSession: MutableCronSession;
  sessionKey: string;
  isNewSession: boolean;
}): Promise<CronAuthSelection | undefined> {
  const nativeAuthProfileIds = resolveBundledCliBackendAuthPolicy(
    params.agentRuntime,
  )?.nativeAuthProfileIds;
  const runtime = await cronAuthProfileRuntimeLoader.load();
  return await runtime.resolveSessionAuthSelection({
    agentId: params.agentId,
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    ...(params.configuredProfileId ? { configuredProfileId: params.configuredProfileId } : {}),
    configuredProfileIsDefault: params.configuredProfileIsDefault,
    nativeAuthProfileIds,
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
