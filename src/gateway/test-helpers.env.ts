// Gateway startup rewrites these process-wide values. Manual in-process test
// owners must snapshot them so later files never inherit a closed server or stale PATH.
export const GATEWAY_STARTUP_MUTATED_ENV_KEYS = [
  "PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_PATH_BOOTSTRAPPED",
] as const;

export const GATEWAY_TEST_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;

/** Captures values that in-process Gateway startup can mutate. */
export function snapshotGatewayStartupEnv(): Record<string, string | undefined> {
  return Object.fromEntries(GATEWAY_STARTUP_MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
}
