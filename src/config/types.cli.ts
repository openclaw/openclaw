export type CliBannerTaglineMode = "random" | "default" | "off" | "script";

export type CliConfig = {
  banner?: {
    /**
     * Controls CLI banner tagline behavior.
     * - "random": pick from tagline pool (default)
     * - "default": always use DEFAULT_TAGLINE
     * - "off": hide tagline text
     * - "script": load tagline from a JS file (set taglineScriptFile to the file path)
     */
    taglineMode?: CliBannerTaglineMode;
    /**
     * Path to a JS file whose default export provides the tagline.
     * Used only when taglineMode is "script".
     * The export may be a string or a (possibly async) function returning a string.
     */
    taglineScriptFile?: string;
  };
};
