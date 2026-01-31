/**
 * Tool Capability Descriptors
 *
 * Defines the scope, constraints, and promise boundaries for each tool.
 * Used to prevent the agent from promising things that tools cannot do.
 */

export interface ToolCapabilityConstraint {
  description: string;
  category: "scope" | "timing" | "state" | "event" | "persistence";
}

export interface ToolCapability {
  name: string;
  summary: string;
  scope: "reactive" | "synchronous" | "persistent" | "query";
  constraints: ToolCapabilityConstraint[];
  canPromise: Record<string, boolean>;
}

export const TOOL_CAPABILITIES: Record<string, ToolCapability> = {
  message: {
    name: "message",
    summary: "Send messages and reactions",
    scope: "reactive",
    constraints: [
      {
        description: "Only sends when agent is actively running",
        category: "timing",
      },
      {
        description: "Cannot monitor for external events or state changes",
        category: "event",
      },
      {
        description: "Cannot be used for proactive notifications without explicit cron job setup",
        category: "event",
      },
      {
        description: "Requires user or system to trigger delivery",
        category: "scope",
      },
    ],
    canPromise: {
      message_in_reply: true,
      message_when_triggered: true,
      message_on_event: false,
      message_periodically: false,
      message_when_system_online: false,
      message_when_file_changes: false,
      proactive_notification: false,
    },
  },

  exec: {
    name: "exec",
    summary: "Run shell commands",
    scope: "synchronous",
    constraints: [
      {
        description: "Runs synchronously during this session only",
        category: "timing",
      },
      {
        description: "Cannot spawn persistent background processes or daemons",
        category: "persistence",
      },
      {
        description: "Terminates when agent session ends",
        category: "persistence",
      },
      {
        description: "Cannot hook into system events or watchdirs",
        category: "event",
      },
    ],
    canPromise: {
      run_command: true,
      run_and_wait: true,
      spawn_background_process: false,
      start_daemon: false,
      monitor_directory: false,
      watch_file: false,
      background_monitoring: false,
    },
  },

  cron: {
    name: "cron",
    summary: "Manage scheduled jobs and wake events",
    scope: "persistent",
    constraints: [
      {
        description: "Requires explicit job creation; does not auto-create",
        category: "scope",
      },
      {
        description: "Only triggers on predefined schedules, not on arbitrary events",
        category: "event",
      },
      {
        description: "Cannot listen for system events (file changes, network events, etc.)",
        category: "event",
      },
      {
        description: "Job must be explicitly created before first execution",
        category: "state",
      },
    ],
    canPromise: {
      schedule_periodic_job: true,
      create_cron_job: true,
      run_at_time: true,
      monitor_file: false,
      listen_for_event: false,
      auto_trigger: false,
      periodic_checks: true,
    },
  },

  browser: {
    name: "browser",
    summary: "Control web browser",
    scope: "synchronous",
    constraints: [
      {
        description: "Runs during active session only",
        category: "timing",
      },
      {
        description: "Cannot monitor websites continuously",
        category: "persistence",
      },
      {
        description: "Cannot auto-refresh or auto-check",
        category: "event",
      },
      {
        description: "Requires explicit user action to check current state",
        category: "scope",
      },
    ],
    canPromise: {
      navigate_and_check: true,
      take_screenshot: true,
      submit_form: true,
      continuous_monitoring: false,
      auto_refresh: false,
      watch_for_changes: false,
      poll_website: false,
    },
  },

  sessions_send: {
    name: "sessions_send",
    summary: "Send message to another session",
    scope: "reactive",
    constraints: [
      {
        description: "Other session must be actively running to receive message",
        category: "timing",
      },
      {
        description: "Cannot guarantee delivery if target session ends",
        category: "state",
      },
      {
        description: "Requires target session key or label",
        category: "scope",
      },
    ],
    canPromise: {
      send_to_active_session: true,
      coordinate_across_sessions: true,
      send_to_offline_session: false,
      guarantee_delivery: false,
    },
  },

  sessions_spawn: {
    name: "sessions_spawn",
    summary: "Spawn sub-agent session",
    scope: "persistent",
    constraints: [
      {
        description: "Creates isolated session; cannot directly share state",
        category: "state",
      },
      {
        description: "Sub-agent runs independently; parent cannot forcibly stop it",
        category: "scope",
      },
      {
        description: "Results delivered asynchronously",
        category: "timing",
      },
    ],
    canPromise: {
      spawn_subagent: true,
      delegate_task: true,
      parallel_work: true,
      real_time_control: false,
      immediate_results: false,
    },
  },
};

/**
 * Check if a tool can fulfill a specific promise
 */
export function canPromise(toolName: string, promiseType: string): boolean {
  const tool = TOOL_CAPABILITIES[toolName.toLowerCase()];
  if (!tool) return false;
  return tool.canPromise[promiseType] ?? false;
}

/**
 * Get all constraints for a tool
 */
export function getToolConstraints(toolName: string): ToolCapabilityConstraint[] {
  const tool = TOOL_CAPABILITIES[toolName.toLowerCase()];
  return tool?.constraints ?? [];
}

/**
 * Get summary of what tool CANNOT do
 */
export function getNegativePromises(toolName: string): string[] {
  const tool = TOOL_CAPABILITIES[toolName.toLowerCase()];
  if (!tool) return [];
  return Object.entries(tool.canPromise)
    .filter(([, allowed]) => !allowed)
    .map(([promise]) => promise);
}
