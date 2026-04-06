import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";

const CORE_SHELL_ENV_EXPECTED_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

export function resolveShellEnvExpectedKeys(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([...listKnownProviderAuthEnvVarNames({ env }), ...CORE_SHELL_ENV_EXPECTED_KEYS]),
  ];
}
