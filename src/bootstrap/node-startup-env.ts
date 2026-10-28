import fs from "node:fs";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { matchesVersionManagerPath } from "../shared/version-manager-path.js";

const LINUX_CA_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
] as const;

// Earlier releases wrote this into macOS services. Apple no longer updates it, so it
// still carries roots the macOS trust store distrusts; NODE_USE_SYSTEM_CA replaces it.
const LEGACY_DARWIN_CA_BUNDLE_PATH = "/etc/ssl/cert.pem";

type EnvMap = Record<string, string | undefined>;

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
  } = {},
): NodeStartupTlsEnvironment {
  const env = params.env ?? (process.env as EnvMap);
  const platform = params.platform ?? process.platform;
  const includeDarwinDefaults = params.includeDarwinDefaults ?? true;

  let nodeExtraCaCerts = readNonBlankString(env.NODE_EXTRA_CA_CERTS);
  if (platform === "darwin" && nodeExtraCaCerts?.trim() === LEGACY_DARWIN_CA_BUNDLE_PATH) {
    nodeExtraCaCerts = undefined;
  }
  if (nodeExtraCaCerts === undefined) {
    if (platform === "linux") {
      const execPath = params.execPath ?? process.execPath;
      // Version-manager Node may not inherit system CAs; supply NODE_EXTRA_CA_CERTS.
      const isVersionManagerRuntime =
        Boolean(env.NVM_DIR?.trim()) || matchesVersionManagerPath(execPath, "linux-ca");
      if (isVersionManagerRuntime) {
        for (const candidate of LINUX_CA_BUNDLE_PATHS) {
          try {
            fs.accessSync(candidate, fs.constants.R_OK);
            nodeExtraCaCerts = candidate;
            break;
          } catch {
            continue;
          }
        }
      }
    }
  }
  const nodeUseSystemCa =
    env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" && includeDarwinDefaults ? "1" : undefined);

  return {
    NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
    NODE_USE_SYSTEM_CA: nodeUseSystemCa,
  };
}
