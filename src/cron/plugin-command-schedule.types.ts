import type { QueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";

// Leaf contract shared by cron types, creation and storage; it must not import those modules.

/** Reserved host payload: a lost private envelope must never become an ordinary model prompt. */
export const PLUGIN_COMMAND_SCHEDULE_MESSAGE = "[plugin-command-scheduled-turn:v1]";

/** Host-captured invocation facts, never a public cron payload or executable grant. */
export type PluginCommandSchedule = {
  version: 1;
  pluginId: string;
  pluginIncarnation: string;
  hostProcessId: string;
  pluginSource: string;
  pluginRoot?: string;
  pluginVersion?: string;
  command: string;
  args?: string;
  channel: string;
  parent: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
  sourceRunId: string;
  operatorSource: QueuedOperatorRecoverySource;
  toolsAllow: string[];
  deadlineAtMs: number;
  maxRuns: number;
};
