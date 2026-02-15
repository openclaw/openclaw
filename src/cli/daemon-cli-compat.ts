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

export function resolveLegacyDaemonCliAccessors(
  bundleSource: string,
): LegacyDaemonCliAccessors | null {
  const aliases = parseExportAliases(bundleSource);
  if (!aliases) {
    return null;
  }

  const registerContainer = findRegisterContainerSymbol(bundleSource);
  const registerContainerAlias = registerContainer ? aliases.get(registerContainer) : undefined;
  const registerDirectAlias = aliases.get("registerDaemonCli");

  const runDaemonInstall = aliases.get("runDaemonInstall");
  const runDaemonRestart = aliases.get("runDaemonRestart");
  const runDaemonStart = aliases.get("runDaemonStart");
  const runDaemonStatus = aliases.get("runDaemonStatus");
  const runDaemonStop = aliases.get("runDaemonStop");
  const runDaemonUninstall = aliases.get("runDaemonUninstall");
  if (!(registerContainerAlias || registerDirectAlias) || !runDaemonRestart) {
    return null;
  }

  const accessors: LegacyDaemonCliAccessors = {
    registerDaemonCli: registerContainerAlias
      ? `${registerContainerAlias}.registerDaemonCli`
      : registerDirectAlias!,
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
