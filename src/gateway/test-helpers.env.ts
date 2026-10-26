import path from "node:path";

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

export const KERNEL_TEST_ENV = {
  OPENCLAW_GATEWAY_PASSWORD: undefined,
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  VITEST: "1",
};

export function createGatewayBackgroundTestEnv(token: string) {
  return {
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

export function createPluginEnabledGatewayTestEnv() {
  return {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  };
}

export function createAuthorityGatewayTestEnv() {
  return {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

/** Captures values that in-process Gateway startup can mutate. */
export function snapshotGatewayStartupEnv(): Record<string, string | undefined> {
  return Object.fromEntries(GATEWAY_STARTUP_MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

export function createGatewayArtifactTestEnv(root: string, state: string, configPath: string) {
  return {
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
  };
}

export const PROVIDER_AUTH_INTEGRATION_ENV = {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  OPENCLAW_OAUTH_DIR: undefined,
  OPENCLAW_GATEWAY_URL: undefined,
  OPENCLAW_GATEWAY_PORT: undefined,
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_GATEWAY_PASSWORD: undefined,
};

export const MODELS_AUTH_INTEGRATION_ENV = {
  OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};

export const WITHOUT_OPENAI_ENV_AUTH = {
  CODEX_API_KEY: undefined,
  CODEX_HOME: "/__openclaw_models_list_test__/codex",
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_OAUTH_TOKEN: undefined,
  CHATGPT_OAUTH_TOKEN: undefined,
} as const;
