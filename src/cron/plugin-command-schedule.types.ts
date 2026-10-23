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

/**
 * Store-private restart continuity, kept in job state so the envelope keeps its released shape.
 * Present only on schedules accepted by a host that re-arms them after a Gateway restart, from a
 * plugin whose loaded code has a code identity: its captured source digest or, for a core-bundled
 * plugin, its exact loaded OpenClaw build. It names the Gateway process and plugin
 * instance currently serving the schedule, and the code identity any later instance must match.
 * Older readers ignore it and keep ending the schedule with its original process.
 */
export type PluginCommandScheduleBinding = {
  hostProcessId: string;
  pluginIncarnation: string;
  /**
   * Code identity fixed when the schedule is accepted: the captured source digest, or a
   * `bundled-build:` identity of a core-bundled plugin's exact build. The released field name
   * stays so stored rows keep one shape.
   */
  sourceDigest: string;
};

/**
 * A loaded plugin instance that can serve requester-command schedules in this Gateway process.
 * Captured on the Gateway thread for the scheduler's claim; never persisted or an authority grant.
 */
export type PluginCommandScheduleHost = {
  pluginId: string;
  pluginIncarnation: string;
  pluginSource: string;
  pluginRoot?: string;
  pluginVersion?: string;
  /** Code identity of what this instance actually loaded; see the binding. */
  sourceDigest: string;
  /** Authenticated native-subagent commands this instance currently registers. */
  commands: string[];
};
