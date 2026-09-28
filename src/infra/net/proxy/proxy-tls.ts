// Managed proxy TLS helpers resolve and load CA trust only for HTTPS forward
// proxies that OpenClaw owns or inherited from a parent process.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import { formatErrorMessage } from "../../errors.js";

/** TLS trust material passed to proxy clients for OpenClaw-managed HTTPS proxies. */
export type ManagedProxyTlsOptions = Readonly<{
  ca?: string;
}>;

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

/** Returns a CA file only for HTTPS proxy URLs; HTTP proxies do not need TLS trust. */
export function resolveManagedProxyCaFileForUrl(params: {
  proxyUrl: string | undefined;
  config?: ProxyConfig;
  caFileOverride?: string;
}): string | undefined {
  if (!isHttpsProxyUrl(params.proxyUrl)) {
    return undefined;
  }
  return (
    normalizeOptionalString(params.caFileOverride) ??
    normalizeOptionalString(params.config?.tls?.caFile)
  );
}

/** Loads managed proxy TLS options asynchronously for startup paths. */
export async function loadManagedProxyTlsOptions(
  caFile: string | undefined,
): Promise<ManagedProxyTlsOptions | undefined> {
  if (!caFile) {
    return undefined;
  }
  try {
    return { ca: await readFile(caFile, "utf8") };
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
    return { ca: readFileSync(caFile, "utf8") };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatErrorMessage(err)}`, {
      cause: err,
    });
  }
}
