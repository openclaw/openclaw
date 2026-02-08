/**
 * Spool configuration types.
 */

export type SpoolConfig = {
  /** Enable spool event processing (default: true). */
  enabled?: boolean;
  /** Default maximum retry attempts for events (default: 3). */
  maxRetries?: number;
};
