export type CliBannerTaglineMode = "random" | "default" | "off";

export type CliTuiConfig = {
  /**
   * "No stream delta arrived" watchdog window for the TUI. When the upstream
   * stream stalls for this long while a run is active, the TUI resets activity
   * status to idle and posts the "taking longer than expected" notice.
   * Default: 600000 (10 minutes). Set to 0 to disable.
   */
  streamingWatchdogMs?: number;
};

export type CliConfig = {
  banner?: {
    /**
     * Controls CLI banner tagline behavior.
     * - "random": pick from tagline pool (default)
     * - "default": always use DEFAULT_TAGLINE
     * - "off": hide tagline text
     */
    taglineMode?: CliBannerTaglineMode;
  };
  /** TUI-side runtime knobs (interactive `openclaw` chat). */
  tui?: CliTuiConfig;
};
