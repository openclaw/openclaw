// Builds Node startup environment variables for subprocess launches.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { type EnvMap, resolveAutoNodeExtraCaCerts } from "./node-extra-ca-certs.js";

// Startup TLS environment defaults for child Node processes. macOS needs
// explicit system-CA env in launch-style contexts; Linux uses version-manager heuristics.
type NodeStartupTlsEnvironment = {
  NODE_EXTRA_CA_CERTS?: string;
  NODE_USE_SYSTEM_CA?: string;
};

/** Resolves NODE_* TLS env values without overwriting user-provided settings. */
export function resolveNodeStartupTlsEnvironment(
  params: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    includeDarwinDefaults?: boolean;
    accessSync?: (path: string, mode?: number) => void;
  } = {},
): NodeStartupTlsEnvironment {
  const env = params.env ?? (process.env as EnvMap);
  const platform = params.platform ?? process.platform;
  const includeDarwinDefaults = params.includeDarwinDefaults ?? true;

  // A blank NODE_EXTRA_CA_CERTS is not a usable override: it would short-circuit
  // CA auto-discovery and be written verbatim into respawned children and
  // daemon service units, so treat empty/whitespace values as unset. Trimming
  // only detects blankness; a nonblank operator path is preserved byte-for-byte.
  const nodeExtraCaCertsOverride = normalizeOptionalString(env.NODE_EXTRA_CA_CERTS)
    ? env.NODE_EXTRA_CA_CERTS
    : undefined;
  const nodeExtraCaCerts =
    nodeExtraCaCertsOverride ??
    (platform === "darwin" && includeDarwinDefaults
      ? "/etc/ssl/cert.pem"
      : resolveAutoNodeExtraCaCerts({
          env,
          platform,
          execPath: params.execPath,
          accessSync: params.accessSync,
        }));
  const nodeUseSystemCa =
    env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" && includeDarwinDefaults ? "1" : undefined);

  return {
    NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
    NODE_USE_SYSTEM_CA: nodeUseSystemCa,
  };
}
