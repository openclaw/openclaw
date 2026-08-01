import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
// Managed proxy TLS helpers resolve and load CA trust only for HTTPS forward
// proxies that OpenClaw owns or inherited from a parent process.
import { readSecretFileSync } from "../../../infra/secret-file.js";

/** TLS trust material passed to proxy clients for OpenClaw-managed HTTPS proxies. */
export type ManagedProxyTlsOptions = Readonly<{
  ca?: string;
}>;

// A managed proxy CA file is a PEM trust bundle. Bound the read so a misconfigured
// or oversized caFile path (config / --proxy-ca-file / proxy CA env override) cannot
// trigger an unbounded allocation at proxy-startup time. 256 KiB comfortably fits a
// realistic multi-certificate trust bundle while still rejecting pathological inputs.
const MANAGED_PROXY_CA_FILE_MAX_BYTES = 256 * 1024;

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatReadError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHttpsProxyUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolves the configured managed proxy CA file, with env/CLI override first. */
function resolveManagedProxyCaFile(params: {
  config?: ProxyConfig;
  caFileOverride?: string;
}): string | undefined {
  return (
    normalizeOptionalPath(params.caFileOverride) ??
    normalizeOptionalPath(params.config?.tls?.caFile)
  );
}

/** Returns a CA file only for HTTPS proxy URLs; HTTP proxies do not need TLS trust. */
export function resolveManagedProxyCaFileForUrl(params: {
  proxyUrl: string | undefined;
  config?: ProxyConfig;
  caFileOverride?: string;
}): string | undefined {
  if (!isHttpsProxyUrl(params.proxyUrl)) {
    return undefined;
  }
  return resolveManagedProxyCaFile({
    config: params.config,
    caFileOverride: params.caFileOverride,
  });
}

/** Loads managed proxy TLS options asynchronously for startup paths. */
export async function loadManagedProxyTlsOptions(
  caFile: string | undefined,
): Promise<ManagedProxyTlsOptions | undefined> {
  if (!caFile) {
    return undefined;
  }
  try {
    return { ca: readProxyCaFileSync(caFile) };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatReadError(err)}`, {
      cause: err,
    });
  }
}

/** Loads managed proxy TLS options synchronously for inherited child-process routing. */
export function loadManagedProxyTlsOptionsSync(
  caFile: string | undefined,
): ManagedProxyTlsOptions | undefined {
  if (!caFile) {
    return undefined;
  }
  try {
    return { ca: readProxyCaFileSync(caFile) };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatReadError(err)}`, {
      cause: err,
    });
  }
}

function readProxyCaFileSync(caFile: string): string {
  return readSecretFileSync(caFile, "Managed proxy CA file", {
    maxBytes: MANAGED_PROXY_CA_FILE_MAX_BYTES,
    rejectHardlinks: false,
  });
}
