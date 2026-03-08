/**
 * Observability domain identifiers — the high-level subsystems that emit
 * structured runtime events via the observability-events module.
 */
export type ObservabilityDomain =
  | "llm"
  | "tool"
  | "run"
  | "queue"
  | "session"
  | (string & Record<never, never>); // allow extension without widening to plain string

/**
 * Runtime observability configuration.
 *
 * Controls the structured observability-events system: domain filtering and
 * optional file-based log mirroring useful for debugging and integration.
 */
export type ObservabilityConfig = {
  /**
   * Master toggle. When false, no events are emitted or mirrored.
   * Defaults to true (enabled).
   */
  enabled?: boolean;

  /** Structured event emission settings. */
  events?: {
    /**
     * Enable or disable the events subsystem entirely.
     * When false, emitObservabilityEvent becomes a no-op.
     */
    enabled?: boolean;

    /**
     * Per-domain enable/disable flags. All domains are enabled by default.
     * Set a domain key to `false` to suppress its events.
     *
     * @example
     * { domains: { tool: false } }  // suppress tool-call events
     */
    domains?: Partial<Record<string, boolean>>;
  };

  /** File-based log mirroring (useful for local debugging and auditing). */
  logs?: {
    /**
     * Enable file mirroring. When true, every emitted event is appended to
     * `filePath` (default: `<tmpDir>/openclaw-observability.log`).
     */
    enabled?: boolean;

    /**
     * Log line format:
     * - `"tail"` (default): compact logfmt-style lines suited for `tail -f`
     * - `"json"`: one JSON object per line (NDJSON)
     */
    format?: "tail" | "json";

    /**
     * Absolute path for the log file. Falls back to a platform temp directory
     * when omitted.
     */
    filePath?: string;

    /**
     * When true, include the event `id` and `seq` fields in each log line.
     * Defaults to false to keep logs concise.
     */
    includeEventIds?: boolean;
  };
};
