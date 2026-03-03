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
};

export type TuiConfig = {
  /**
   * Deliver assistant replies to stdout by default.
   * When false (default), replies are stored but not printed.
   * Can be overridden with --deliver flag.
   */
  deliver?: boolean;
};
