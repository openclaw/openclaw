export type CliBannerTaglineMode = "random" | "default" | "off";

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
  tui?: {
    /**
     * Default value for --deliver flag in TUI command.
     * When true, assistant replies are delivered to stdout by default.
     * Can be overridden with --deliver flag at runtime.
     */
    deliver?: boolean;
  };
};
