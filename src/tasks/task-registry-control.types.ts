// Task state imports this leaf; importing runtime barrels here closes a type dependency cycle.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";

export type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: DetachedTaskTerminalState };

export type SubagentAdminKillResult =
  | { found: false; killed: false }
  | {
      found: true;
      killed: boolean;
      runId: string;
      sessionKey: string;
      cascadeKilled: number;
      cascadeLabels?: string[];
      targetState?: SubagentKillTargetState;
      error?: string;
    };

export type SubagentAdminKillParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  expectedRunId?: string;
  /** Stable task identity; resolves once to the current execution before cancellation. */
  expectedTaskRunId?: string;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
  /** Consume the result synchronously while its exact run ownership is still held. */
  onResult?: (result: SubagentAdminKillResult) => undefined;
};
