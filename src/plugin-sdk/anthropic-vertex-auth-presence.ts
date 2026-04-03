import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";

const GCLOUD_DEFAULT_ADC_PATH = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);

function hasAnthropicVertexMetadataServerAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitMetadataOptIn = normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_USE_GCP_METADATA);
  return explicitMetadataOptIn === "1" || explicitMetadataOptIn?.toLowerCase() === "true";
}

function resolveAnthropicVertexDefaultAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  return platform() === "win32"
    ? join(
        env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "gcloud",
        "application_default_credentials.json",
      )
    : GCLOUD_DEFAULT_ADC_PATH;
}

function resolveAnthropicVertexAdcCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicitCredentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicitCredentialsPath) {
    return existsSync(explicitCredentialsPath) ? explicitCredentialsPath : undefined;
  }

  const defaultAdcPath = resolveAnthropicVertexDefaultAdcPath(env);
  return existsSync(defaultAdcPath) ? defaultAdcPath : undefined;
}

export function hasAnthropicVertexAvailableAuth(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasAnthropicVertexMetadataServerAdc(env) ||
    resolveAnthropicVertexAdcCredentialsPath(env) !== undefined
  );
}
