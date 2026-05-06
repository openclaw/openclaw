/**
 * Task registry maintenance config.
 *
 * The task registry tracks every spawned task (cron run, CLI invocation,
 * subagent, ACP session) for inspection and cleanup. After a task reaches a
 * terminal status it is retained for `retentionMs` to support post-mortem
 * inspection, then pruned by the periodic sweep.
 */
export type TasksConfig = {
  /**
   * How long to retain terminal task records before they are eligible for
   * pruning by the registry sweep.
   *
   * Accepts a millisecond integer. Default: `7 * 24 * 60 * 60 * 1000`
   * (seven days). Lower values reduce the number of records walked by every
   * sweep at the cost of a shorter post-mortem window.
   */
  retentionMs?: number;
  /**
   * How often the task registry maintenance sweep runs in milliseconds.
   *
   * Default: `60_000` (one minute). The sweep is short-lived on a quiet
   * system and infrequent enough that this rarely needs tuning, but is
   * exposed for environments with very large or very small task volumes.
   */
  sweepIntervalMs?: number;
};
