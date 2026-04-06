export const LEGACY_DAEMON_CLI_EXPORTS = [
  "registerDaemonCli",
  "runDaemonInstall",
  "runDaemonRestart",
  "runDaemonStart",
  "runDaemonStatus",
  "runDaemonStop",
  "runDaemonUninstall",
] as const;

type LegacyDaemonCliExport = (typeof LEGACY_DAEMON_CLI_EXPORTS)[number];
export type LegacyDaemonCliAccessors = {
  registerDaemonCli: string;
  runDaemonRestart: string;
} & Partial<
  Record<Exclude<LegacyDaemonCliExport, "registerDaemonCli" | "runDaemonRestart">, string>
>;

const EXPORT_SPEC_RE = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;
const REGISTER_CONTAINER_RE =
  /(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?__exportAll\(\{\s*registerDaemonCli\s*:\s*\(\)\s*=>\s*registerDaemonCli\s*\}\)/;

function parseExportAliases(bundleSource: string): Map<string, string> | null {
  const matches = [...bundleSource.matchAll(/export\s*\{([^}]+)\}\s*;?/g)];
  if (matches.length === 0) {
    return null;
  }
  const last = matches.at(-1);
  const body = last?.[1];
  if (!body) {
    return null;
  }

  const aliases = new Map<string, string>();
  for (const chunk of body.split(",")) {
    const spec = chunk.trim();
    if (!spec) {
      continue;
    }
    const parsed = spec.match(EXPORT_SPEC_RE);
    if (!parsed) {
      return null;
    }
    const original = parsed[1];
    const alias = parsed[2] ?? original;
    aliases.set(original, alias);
  }
  return aliases;
}

function findRegisterContainerSymbol(bundleSource: string): string | null {
  return bundleSource.match(REGISTER_CONTAINER_RE)?.[1] ?? null;
}

export function resolveAliasedExportAccessor(
  bundleSource: string,
  exportName: LegacyDaemonCliExport,
): string | null {
  return parseExportAliases(bundleSource)?.get(exportName) ?? null;
}

export function resolveLegacyDaemonCliRegisterAccessor(bundleSource: string): string | null {
  const aliases = parseExportAliases(bundleSource);
  if (!aliases) {
    return null;
  }

  const registerContainer = findRegisterContainerSymbol(bundleSource);
  const registerContainerAlias = registerContainer ? aliases.get(registerContainer) : undefined;
  const registerDirectAlias = aliases.get("registerDaemonCli");
  if (registerContainerAlias) {
    return `${registerContainerAlias}.registerDaemonCli`;
  }
  return registerDirectAlias ?? null;
}

export function resolveLegacyDaemonCliAccessors(
  bundleSource: string,
): LegacyDaemonCliAccessors | null {
  const registerDaemonCli = resolveLegacyDaemonCliRegisterAccessor(bundleSource);
  const runDaemonInstall = resolveAliasedExportAccessor(bundleSource, "runDaemonInstall");
  const runDaemonRestart = resolveAliasedExportAccessor(bundleSource, "runDaemonRestart");
  const runDaemonStart = resolveAliasedExportAccessor(bundleSource, "runDaemonStart");
  const runDaemonStatus = resolveAliasedExportAccessor(bundleSource, "runDaemonStatus");
  const runDaemonStop = resolveAliasedExportAccessor(bundleSource, "runDaemonStop");
  const runDaemonUninstall = resolveAliasedExportAccessor(bundleSource, "runDaemonUninstall");
  if (!registerDaemonCli || !runDaemonRestart) {
    return null;
  }

  const accessors: LegacyDaemonCliAccessors = {
    registerDaemonCli,
    runDaemonRestart,
  };
  if (runDaemonInstall) {
    accessors.runDaemonInstall = runDaemonInstall;
  }
  if (runDaemonStart) {
    accessors.runDaemonStart = runDaemonStart;
  }
  if (runDaemonStatus) {
    accessors.runDaemonStatus = runDaemonStatus;
  }
  if (runDaemonStop) {
    accessors.runDaemonStop = runDaemonStop;
  }
  if (runDaemonUninstall) {
    accessors.runDaemonUninstall = runDaemonUninstall;
  }
  return accessors;
}
