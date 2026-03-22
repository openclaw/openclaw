import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

type HookInternalEntryLike = Record<string, unknown> & { enabled?: boolean };

export function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

export function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
): { config: OpenClawConfig; warnings: string[] } {
  const report = buildPluginStatusReport({ config });
  const plugin = report.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}

export function createPluginInstallLogger(): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => defaultRuntime.log(msg),
    warn: (msg) => defaultRuntime.log(theme.warn(msg)),
  };
}

export function createHookPackInstallLogger(): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => defaultRuntime.log(msg),
    warn: (msg) => defaultRuntime.log(theme.warn(msg)),
  };
}

export function enableInternalHookEntries(
  config: OpenClawConfig,
  hookNames: string[],
): OpenClawConfig {
  const entries = { ...config.hooks?.internal?.entries } as Record<string, HookInternalEntryLike>;

  for (const hookName of hookNames) {
    entries[hookName] = {
      ...entries[hookName],
      enabled: true,
    };
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        enabled: true,
        entries,
      },
    },
  };
}

export function extractInstalledNpmPackageName(install: PluginInstallRecord): string | undefined {
  if (install.source !== "npm") {
    return undefined;
  }
  const resolvedName = install.resolvedName?.trim();
  if (resolvedName) {
    return resolvedName;
  }
  return (
    (install.spec ? parseRegistryNpmSpec(install.spec)?.name : undefined) ??
    (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : undefined)
  );
}

export function extractInstalledNpmHookPackageName(install: HookInstallRecord): string | undefined {
  const resolvedName = install.resolvedName?.trim();
  if (resolvedName) {
    return resolvedName;
  }
  return (
    (install.spec ? parseRegistryNpmSpec(install.spec)?.name : undefined) ??
    (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : undefined)
  );
}

export function formatPluginInstallWithHookFallbackError(
  pluginError: string,
  hookError: string,
): string {
  return `${pluginError}\nAlso not a valid hook pack: ${hookError}`;
}

export function logHookPackRestartHint() {
  defaultRuntime.log("Restart the gateway to load hooks.");
}

export async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function logSlotWarnings(warnings: string[]) {
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
}

export function buildPreferredClawHubSpec(raw: string): string | null {
  const parsed = parseRegistryNpmSpec(raw);
  if (!parsed) {
    return null;
  }
  return `clawhub:${parsed.name}${parsed.selector ? `@${parsed.selector}` : ""}`;
}

export function shouldFallbackFromClawHubToNpm(error: string): boolean {
  const normalized = error.trim();
  return (
    /Package not found on ClawHub/i.test(normalized) ||
    /ClawHub .* failed \(404\)/i.test(normalized) ||
    /Version not found/i.test(normalized)
  );
}
