// Product/package naming constants that bridge current OpenClaw manifests with
// legacy Clawdbot keys still seen in older configs and packages.
export const MANIFEST_KEY = "openclaw" as const;

/** Manifest keys accepted only for legacy compatibility. */
export const LEGACY_MANIFEST_KEYS = ["clawdbot"] as const;
