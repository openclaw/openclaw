import { readSecretFile, readSecretFileSync } from "@openclaw/fs-safe/secret";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import { formatErrorMessage } from "../../errors.js";

/** TLS trust material passed to proxy clients for OpenClaw-managed HTTPS proxies. */
export type ManagedProxyTlsOptions = Readonly<{
  ca?: string;
}>;

/** Returns a CA file only for HTTPS proxy URLs; HTTP proxies do not need TLS trust. */
export function resolveManagedProxyCaFileForUrl(params: {
  proxyUrl: string | undefined;
  config?: ProxyConfig;
  caFileOverride?: string;
}): string | undefined {
  if (!params.proxyUrl || URL.parse(params.proxyUrl)?.protocol !== "https:") {
    return undefined;
  }
  return (
    normalizeOptionalString(params.caFileOverride) ??
    normalizeOptionalString(params.config?.tls?.caFile)
  );
}

// A managed proxy CA file is a PEM trust bundle. Bound the read through the shared
// secret-file reader so a misconfigured caFile (config / --proxy-ca-file / env override)
// cannot hang proxy startup on a special file or allocate unbounded memory. A single
// root certificate is ~2 KiB and full OS trust bundles measure in the hundreds of KiB
// (this machine's ~130-certificate system bundle is ~205 KiB), so a 4 MiB bound admits
// every realistic trust bundle — well over 2000 root certificates, more than any known
// OS or enterprise trust store — while still rejecting pathological inputs.
const MANAGED_PROXY_CA_FILE_MAX_BYTES = 4 * 1024 * 1024;

const managedProxyCaFileReadOptions = {
  maxBytes: MANAGED_PROXY_CA_FILE_MAX_BYTES,
  // Hardlinked trust bundles are ordinary files; only special files are refused.
  rejectHardlinks: false,
} as const;

/** Loads managed proxy TLS options asynchronously for startup paths. */
export async function loadManagedProxyTlsOptions(
  caFile: string | undefined,
): Promise<ManagedProxyTlsOptions | undefined> {
  if (!caFile) {
    return undefined;
  }
  try {
    return {
      ca: await readSecretFile(caFile, "Managed proxy CA", managedProxyCaFileReadOptions),
    };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatErrorMessage(err)}`, {
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
    return {
      ca: readSecretFileSync(caFile, "Managed proxy CA", managedProxyCaFileReadOptions),
    };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatErrorMessage(err)}`, {
      cause: err,
    });
  }
}
