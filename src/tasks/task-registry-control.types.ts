// Defines task control runtime contracts exposed to command surfaces.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";

type KillSubagentTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: DetachedTaskTerminalState };

/** Admin cancellation hook for ACP sessions owned by task records. */
export type CancelAcpSessionAdmin = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: string;
}) => Promise<void>;

export type KillSubagentRunAdminResult =
  | { found: false; killed: false }
  | {
      found: true;
      killed: boolean;
      targetState?: KillSubagentTargetState;
      runId: string;
      sessionKey: string;
      cascadeKilled: number;
      cascadeLabels?: string[];
    };

export type KillSubagentRunAdmin = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}) => Promise<KillSubagentRunAdminResult>;

export type TaskRegistryControlRuntime = {
  getAcpSessionManager: () => {
    cancelSession: CancelAcpSessionAdmin;
  };
  killSubagentRunAdmin: KillSubagentRunAdmin;
};
