export type CliBannerTaglineMode = "random" | "default" | "off";

export type CliLocale = "en" | "zh-CN";

export type CliConfig = {
  locale?: CliLocale;
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
