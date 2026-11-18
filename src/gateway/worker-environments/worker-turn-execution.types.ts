import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { PreparedModelRuntimeLeaseOptions } from "../../agents/prepared-model-runtime.types.js";
import type { WorkerTurnEnvironmentService } from "./worker-turn-failure.js";
import type { WorkerPreparationPhase } from "./worker-turn-preparation-qualification.js";
import type { executeRemoteExecTurn } from "./workspace-result-finalize.js";

export type WorkerTurnExecutionParams = Omit<
  Parameters<typeof executeRemoteExecTurn>[0],
  "environments" | "runLocal"
> & {
  environments: WorkerTurnEnvironmentService;
  qualificationPhase?: (phase?: WorkerPreparationPhase) => void;
  qualificationAcquisition?: () => PreparedModelRuntimeLeaseOptions["qualification"];
  assertRunCurrent: () => void;
  onTerminal: () => void;
  onReply: (result: EmbeddedAgentRunResult) => void;
};
