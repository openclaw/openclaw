import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { AgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { CronAgentExecutionPhaseUpdate } from "../types.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import type { PreparedCronRunContext } from "./run-prepare.js";
import type { CronRunContinuationSession } from "./run-session-state.js";
import type { CronCompletedPromptRun, CronRunnerStartedInfo } from "./run.types.js";

/** Inputs owned by one isolated cron execution. */
export type CronRunExecutionParams = Pick<
  PreparedCronRunContext,
  | "cfgWithAgentDefaults"
  | "agentId"
  | "agentDir"
  | "agentSessionKey"
  | "runSessionKey"
  | "usesDetachedRunSession"
  | "workspaceDir"
  | "executionRoot"
  | "timeoutMs"
  | "runTimeoutOverrideMs"
  | "suppressExecNotifyOnExit"
  | "resolvedDelivery"
  | "deliveryRequested"
  | "sourceDelivery"
  | "skillsSnapshot"
  | "agentPayload"
  | "useSubagentFallbacks"
  | "inheritDefaultFallbacksForAgentStringModel"
  | "modelFallbacksOverride"
  | "liveSelection"
  | "cronSession"
  | "commandBody"
  | "inputProvenance"
  | "persistSessionEntry"
> &
  Pick<RunCronAgentTurnParams, "cfg" | "job" | "lane" | "onLaneWait" | "executionIdentity"> & {
    runId: string;
    agentVerboseDefault: AgentDefaultsConfig["verboseDefault"];
    immutableThinkLevel: ThinkLevel | undefined;
    thinkingCatalog?: ModelCatalogEntry[];
    loadThinkingCatalog: (
      provider: string,
      model: string,
      agentRuntime: string,
    ) => Promise<ModelCatalogEntry[]>;
    persistRunContinuationSession?: CronRunContinuationSession["sync"];
    setRunContinuationCliExecutionProvider?: (provider?: string) => Promise<void>;
    abortSignal?: AbortSignal;
    abortReason: () => string;
    isAborted: () => boolean;
    lifecycle: Omit<AgentLifecycleTerminalBackstop, "emit">;
    onExecutionStarted?: (info?: CronRunnerStartedInfo) => void;
    onExecutionPhase?: (
      info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
        Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
    ) => void;
    onPromptCompleted?: (runs: readonly CronCompletedPromptRun[]) => void;
    runStartedAt?: number;
  };
