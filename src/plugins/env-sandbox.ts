/**
 * Plugin environment sandbox.
 *
 * Provides a filtered copy of process.env for plugins, stripping sensitive
 * credentials (API keys, tokens, passwords) that plugins should never access
 * directly. Plugins that need provider credentials should use the runtime
 * config API instead.
 */

const SENSITIVE_PREFIXES: readonly string[] = [
  "OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_",
  "AZURE_",
  "AWS_",
  "ELEVENLABS_",
  "XI_",
  "DEEPGRAM_",
  "COHERE_",
  "MISTRAL_",
  "GROQ_",
  "TOGETHER_",
  "FIREWORKS_",
  "PERPLEXITY_",
  "REPLICATE_",
  "HUGGING_FACE_",
  "HF_",
  "OPENROUTER_",
  "ANYSCALE_",
  "NVIDIA_",
  "CHUTES_",
  "DEEPSEEK_",
  "CEREBRAS_",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "SIGNAL_",
  "WHATSAPP_",
  "LINE_",
  "TWILIO_",
  "COMPOSIO_",
  "SUPABASE_",
  "DATABASE_",
  "REDIS_",
  "MONGO",
  "MYSQL_",
  "POSTGRES",
  "SMTP_",
  "SENDGRID_",
  "MAILGUN_",
  "STRIPE_",
  "SENTRY_",
];

const SENSITIVE_SUFFIXES: readonly string[] = [
  "_API_KEY",
  "_SECRET",
  "_TOKEN",
  "_PASSWORD",
  "_CREDENTIALS",
  "_PRIVATE_KEY",
  "_SECRET_KEY",
  "_ACCESS_KEY",
  "_AUTH",
];

const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  "SECRET",
  "PASSWORD",
  "CREDENTIALS",
  "API_KEY",
  "AUTH_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
]);

export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();

  if (SENSITIVE_EXACT.has(upper)) {
    return true;
  }
  if (SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => upper.endsWith(suffix))) {
    return true;
  }
  return false;
}

/**
 * Create a filtered environment for plugin execution.
 *
 * Strips all sensitive credential keys from the environment. Plugins receive
 * only non-sensitive variables (PATH, HOME, LANG, NODE_ENV, etc).
 */
export function createPluginEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    if (isSensitiveEnvKey(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}
