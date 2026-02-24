import type { OpenClawConfig } from "../config/config.js";
import type { SecretRef } from "../config/types.secrets.js";
import { resolveUserPath } from "../utils.js";
import { readJsonPointer } from "./json-pointer.js";
import { isNonEmptyString, normalizePositiveInt } from "./shared.js";
import { decryptSopsJsonFile, DEFAULT_SOPS_TIMEOUT_MS } from "./sops.js";

export type SecretRefResolveCache = {
  fileSecretsPromise?: Promise<unknown> | null;
};

type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
  missingBinaryMessage?: string;
};

const DEFAULT_SOPS_MISSING_BINARY_MESSAGE =
  "sops binary not found in PATH. Install sops >= 3.9.0 or disable secrets.sources.file.";

async function resolveFileSecretPayload(options: ResolveSecretRefOptions): Promise<unknown> {
  const fileSource = options.config.secrets?.sources?.file;
  if (!fileSource) {
    throw new Error(
      'Secret reference source "file" is not configured. Configure secrets.sources.file first.',
    );
  }
  if (fileSource.type !== "sops") {
    throw new Error(`Unsupported secrets.sources.file.type "${String(fileSource.type)}".`);
  }

  const cache = options.cache;
  if (cache?.fileSecretsPromise) {
    return await cache.fileSecretsPromise;
  }

  const promise = decryptSopsJsonFile({
    path: resolveUserPath(fileSource.path),
    timeoutMs: normalizePositiveInt(fileSource.timeoutMs, DEFAULT_SOPS_TIMEOUT_MS),
    missingBinaryMessage: options.missingBinaryMessage ?? DEFAULT_SOPS_MISSING_BINARY_MESSAGE,
  });
  if (cache) {
    cache.fileSecretsPromise = promise;
  }
  return await promise;
}

export async function resolveSecretRefValue(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<unknown> {
  const id = ref.id.trim();
  if (!id) {
    throw new Error("Secret reference id is empty.");
  }

  if (ref.source === "env") {
    const envValue = options.env?.[id] ?? process.env[id];
    if (!isNonEmptyString(envValue)) {
      throw new Error(`Environment variable "${id}" is missing or empty.`);
    }
    return envValue;
  }

  if (ref.source === "file") {
    const payload = await resolveFileSecretPayload(options);
    return readJsonPointer(payload, id, { onMissing: "throw" });
  }

  throw new Error(`Unsupported secret source "${String((ref as { source?: unknown }).source)}".`);
}

export async function resolveSecretRefString(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<string> {
  const resolved = await resolveSecretRefValue(ref, options);
  if (!isNonEmptyString(resolved)) {
    throw new Error(
      `Secret reference "${ref.source}:${ref.id}" resolved to a non-string or empty value.`,
    );
  }
  return resolved;
}
