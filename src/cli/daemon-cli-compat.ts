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
): Record<LegacyDaemonCliExport, string> | null {
  const partial = resolvePartialDaemonCliAccessors(bundleSource);
  if (!partial) {
    return null;
  }
  for (const name of LEGACY_DAEMON_CLI_EXPORTS) {
    if (!partial[name]) {
      return null;
    }
  }
  return partial as Record<LegacyDaemonCliExport, string>;
}

export function resolvePartialDaemonCliAccessors(
  bundleSource: string,
): Partial<Record<LegacyDaemonCliExport, string>> | null {
  const aliases = parseExportAliases(bundleSource);
  if (!aliases) {
    return null;
  }

  const result: Partial<Record<LegacyDaemonCliExport, string>> = {};

  const registerContainer = findRegisterContainerSymbol(bundleSource);
  const registerContainerAlias = registerContainer ? aliases.get(registerContainer) : undefined;
  const registerDirectAlias = aliases.get("registerDaemonCli");
  if (registerContainerAlias) {
    result.registerDaemonCli = `${registerContainerAlias}.registerDaemonCli`;
  } else if (registerDirectAlias) {
    result.registerDaemonCli = registerDirectAlias;
  }

  for (const name of LEGACY_DAEMON_CLI_EXPORTS) {
    if (name === "registerDaemonCli") {
      continue;
    }
    const alias = aliases.get(name);
    if (alias) {
      result[name] = alias;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
