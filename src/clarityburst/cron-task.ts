/**
 * Cron Task Enum and Registry for CronPreflightGate
 *
 * Defines a closed universe of allowed cron task types,
 * each with metadata describing required capabilities, risk class,
 * and execution constraints.
 */

/**
 * Closed enumeration of allowed cron task IDs.
 * Must be declared upfront; no runtime additions allowed.
 */
export type CronTaskId =
  | "HEARTBEAT_CHECK"
  | "MEMORY_MAINTENANCE"
  | "CACHE_REFRESH"
  | "LOG_ROTATION"
  | "BACKUP_EXECUTION"
  | "SCHEDULED_REPORT"
  | "CREDENTIAL_ROTATION"
  | "HEALTH_PROBE"
  | "INDEX_REBUILD"
  | "STATE_SYNC"
  | "METRICS_AGGREGATION"
  | "CLEANUP_TEMP_DATA"
  | "UPDATE_CONFIG_CACHE";

/** Immutable array of all valid cron task IDs */
export const CRON_TASK_IDS = [
  "HEARTBEAT_CHECK",
  "MEMORY_MAINTENANCE",
  "CACHE_REFRESH",
  "LOG_ROTATION",
  "BACKUP_EXECUTION",
  "SCHEDULED_REPORT",
  "CREDENTIAL_ROTATION",
  "HEALTH_PROBE",
  "INDEX_REBUILD",
  "STATE_SYNC",
  "METRICS_AGGREGATION",
  "CLEANUP_TEMP_DATA",
  "UPDATE_CONFIG_CACHE",
] as const;

/**
 * Type guard to validate task IDs at runtime.
 */
export function isValidCronTaskId(value: string): value is CronTaskId {
  return CRON_TASK_IDS.includes(value as CronTaskId);
}

/**
 * Risk classification for cron tasks
 */
export type RiskClass = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Metadata declaration for each cron task.
 * Describes capabilities, risk level, and execution constraints.
 */
export interface CronTaskMetadata {
  /** Task identifier */
  taskId: CronTaskId;
  /** Human-readable description */
  description: string;
  /** Capabilities required to execute this task */
  requiredCapabilities: string[];
  /** Risk class for this task */
  riskClass: RiskClass;
  /** Whether manual confirmation is needed */
  needsConfirmation: boolean;
  /** Max concurrent instances of this task */
  concurrencyLimit: number;
  /** Timeout in seconds */
  timeoutSeconds: number;
  /** Optional frequency constraint (e.g., "at_most_hourly") */
  frequencyConstraint?: string;
}

/**
 * Registry mapping cron task IDs to their metadata.
 * Fail-closed: any undefined task is invalid.
 */
export const CRON_TASK_REGISTRY: Record<CronTaskId, CronTaskMetadata> = {
  HEARTBEAT_CHECK: {
    taskId: "HEARTBEAT_CHECK",
    description: "Periodic system health monitoring",
    requiredCapabilities: ["network"],
    riskClass: "LOW",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 30,
    frequencyConstraint: "at_most_hourly",
  },
  MEMORY_MAINTENANCE: {
    taskId: "MEMORY_MAINTENANCE",
    description: "Garbage collection and cache cleanup",
    requiredCapabilities: ["sensitive_access"],
    riskClass: "MEDIUM",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 60,
  },
  CACHE_REFRESH: {
    taskId: "CACHE_REFRESH",
    description: "Update cached data from sources",
    requiredCapabilities: ["network"],
    riskClass: "LOW",
    needsConfirmation: false,
    concurrencyLimit: 2,
    timeoutSeconds: 45,
  },
  LOG_ROTATION: {
    taskId: "LOG_ROTATION",
    description: "Archive and compress old logs",
    requiredCapabilities: ["file_system"],
    riskClass: "LOW",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 120,
  },
  BACKUP_EXECUTION: {
    taskId: "BACKUP_EXECUTION",
    description: "Incremental backup operations",
    requiredCapabilities: ["file_system", "sensitive_access"],
    riskClass: "MEDIUM",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 180,
  },
  SCHEDULED_REPORT: {
    taskId: "SCHEDULED_REPORT",
    description: "Generate and deliver reports",
    requiredCapabilities: ["network", "file_system"],
    riskClass: "LOW",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 90,
  },
  CREDENTIAL_ROTATION: {
    taskId: "CREDENTIAL_ROTATION",
    description: "Refresh authentication tokens and credentials",
    requiredCapabilities: ["sensitive_access", "critical_opt_in"],
    riskClass: "CRITICAL",
    needsConfirmation: true,
    concurrencyLimit: 1,
    timeoutSeconds: 120,
  },
  HEALTH_PROBE: {
    taskId: "HEALTH_PROBE",
    description: "External service availability checks",
    requiredCapabilities: ["network"],
    riskClass: "LOW",
    needsConfirmation: false,
    concurrencyLimit: 3,
    timeoutSeconds: 30,
  },
  INDEX_REBUILD: {
    taskId: "INDEX_REBUILD",
    description: "Database/search index maintenance",
    requiredCapabilities: ["file_system", "sensitive_access"],
    riskClass: "HIGH",
    needsConfirmation: true,
    concurrencyLimit: 1,
    timeoutSeconds: 600,
  },
  STATE_SYNC: {
    taskId: "STATE_SYNC",
    description: "Synchronize distributed state",
    requiredCapabilities: ["network", "sensitive_access"],
    riskClass: "MEDIUM",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 60,
  },
  METRICS_AGGREGATION: {
    taskId: "METRICS_AGGREGATION",
    description: "Collect and summarize metrics",
    requiredCapabilities: ["network", "file_system"],
    riskClass: "LOW",
    needsConfirmation: false,
    concurrencyLimit: 2,
    timeoutSeconds: 90,
  },
  CLEANUP_TEMP_DATA: {
    taskId: "CLEANUP_TEMP_DATA",
    description: "Remove temporary files and records",
    requiredCapabilities: ["file_system"],
    riskClass: "MEDIUM",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 60,
  },
  UPDATE_CONFIG_CACHE: {
    taskId: "UPDATE_CONFIG_CACHE",
    description: "Refresh cached configuration",
    requiredCapabilities: ["network", "sensitive_access"],
    riskClass: "MEDIUM",
    needsConfirmation: false,
    concurrencyLimit: 1,
    timeoutSeconds: 30,
  },
} as const;

/**
 * Validates and asserts that a task is in the enum.
 * Throws an error if the task is invalid.
 * Fail-closed: any invalid task raises an error.
 *
 * @param task - The task string to validate
 * @returns The validated CronTaskId
 * @throws Error if task is not a valid CronTaskId
 */
export function assertValidCronTask(task: string): CronTaskId {
  if (!isValidCronTaskId(task)) {
    throw new Error(
      `Invalid cron task: "${task}". Must be one of: ${CRON_TASK_IDS.join(", ")}`
    );
  }
  return task;
}

/**
 * Get metadata for a cron task.
 * Returns undefined if task is not in registry (fail-closed).
 *
 * @param taskId - The task ID to look up
 * @returns Metadata if found, undefined otherwise
 */
export function getCronTaskMetadata(taskId: CronTaskId): CronTaskMetadata | undefined {
  return CRON_TASK_REGISTRY[taskId];
}
