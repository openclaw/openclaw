import fs from "node:fs";

export const LINUX_CA_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
] as const;

export type EnvMap = Record<string, string | undefined>;
type AccessSyncFn = (path: string, mode?: number) => void;

export function resolveLinuxSystemCaBundle(
  params: {
    platform?: NodeJS.Platform;
    accessSync?: AccessSyncFn;
  } = {},
): string | undefined {
  const platform = params.platform ?? process.platform;
  if (platform !== "linux") {
    return undefined;
  }

  const accessSync = params.accessSync ?? fs.accessSync.bind(fs);
  for (const candidate of LINUX_CA_BUNDLE_PATHS) {
    try {
      accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function isNodeVersionManagerRuntime(
  env: EnvMap = process.env as EnvMap,
  execPath: string = process.execPath,
): boolean {
  if (env.NVM_DIR?.trim()) {
    return true;
  }
  return execPath.includes("/.nvm/");
}

export function resolveAutoNodeExtraCaCerts(
  params: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    accessSync?: AccessSyncFn;
  } = {},
): string | undefined {
  const env = params.env ?? (process.env as EnvMap);
  if (env.NODE_EXTRA_CA_CERTS?.trim()) {
    return undefined;
  }

  const platform = params.platform ?? process.platform;
  const execPath = params.execPath ?? process.execPath;
  if (platform !== "linux" || !isNodeVersionManagerRuntime(env, execPath)) {
    return undefined;
  }

  return resolveLinuxSystemCaBundle({
    platform,
    accessSync: params.accessSync,
  });
}
