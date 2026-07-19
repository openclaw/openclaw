// Anthropic Vertex auth helpers detect local credential presence for provider setup flows.
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { tryReadSecretFileSync } from "./secret-file-runtime.js";

// Bound ADC credential reads so an oversized GOOGLE_APPLICATION_CREDENTIALS file
// cannot trigger an unbounded memory read. Mirrors the provider-local copy in
// extensions/anthropic-vertex/region.ts (#109260).
const ANTHROPIC_VERTEX_ADC_FILE_MAX_BYTES = 1024 * 1024;

const GCLOUD_DEFAULT_ADC_PATH = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);

function hasAnthropicVertexMetadataServerAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitMetadataOptIn = normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_USE_GCP_METADATA);
  return (
    explicitMetadataOptIn === "1" ||
    normalizeLowercaseStringOrEmpty(explicitMetadataOptIn) === "true"
  );
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

function resolveAnthropicVertexAdcCredentialsPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeOptionalString(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) {
    return explicit;
  }
  // Only probe the user's default ADC file for the real process environment; injected
  // test/runtime env objects should not accidentally depend on host filesystem state.
  if (env !== process.env) {
    return undefined;
  }
  return resolveAnthropicVertexDefaultAdcPath(env);
}

function canReadAnthropicVertexAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  const credentialsPath = resolveAnthropicVertexAdcCredentialsPathCandidate(env);
  if (!credentialsPath) {
    return false;
  }
  // Presence check only: the contents are discarded, so a bounded read is
  // sufficient and avoids slurping an oversized credential file into memory.
  // tryReadSecretFileSync still throws on oversize, so guard like region.ts.
  try {
    const text = tryReadSecretFileSync(credentialsPath, "Anthropic Vertex ADC credentials", {
      maxBytes: ANTHROPIC_VERTEX_ADC_FILE_MAX_BYTES,
      rejectHardlinks: false,
    });
    return text !== undefined;
  } catch {
    return false;
  }
}

/**
 * Return whether Anthropic Vertex can authenticate through GCP metadata or ADC credentials.
 * This is a preflight signal only; provider calls still perform their own auth validation.
 */
export function hasAnthropicVertexAvailableAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasAnthropicVertexMetadataServerAdc(env) || canReadAnthropicVertexAdc(env);
}
