/** Audits configured plugins.load.paths entries for filesystem and trust-boundary risk. */
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { scanBundledPluginLoadPathMigrations } from "../commands/doctor/shared/bundled-plugin-load-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import { discoverConfiguredPluginLoadPaths } from "../plugins/discovery.js";
import { resolveUserPath } from "../utils.js";
import { formatPermissionDetail, inspectPathPermissions } from "./audit-fs.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import type { ExecFn } from "./windows-acl.js";

function isProbablySyncedPath(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("icloud") ||
    normalized.includes("dropbox") ||
    normalized.includes("google drive") ||
    normalized.includes("googledrive") ||
    normalized.includes("onedrive")
  );
}

function classifyDiscoveryDiagnostic(message: string): {
  checkId: string;
  severity: SecurityAuditFinding["severity"];
} | null {
  if (message.includes("world-writable path")) {
    return { checkId: "plugins.load_paths.world_writable", severity: "critical" };
  }
  if (message.includes("suspicious ownership")) {
    return { checkId: "plugins.load_paths.suspicious_ownership", severity: "warn" };
  }
  if (message.includes("source escapes plugin root")) {
    return { checkId: "plugins.load_paths.source_escapes_root", severity: "critical" };
  }
  if (message.includes("cannot stat path")) {
    return { checkId: "plugins.load_paths.missing", severity: "warn" };
  }
  if (message.includes("ignored plugins.load.paths entry")) {
    return { checkId: "plugins.load_paths.bundled_alias", severity: "warn" };
  }
  if (message.includes("blocked plugin candidate")) {
    return { checkId: "plugins.load_paths.blocked_candidate", severity: "warn" };
  }
  return null;
}

function pushLine(lines: string[], line: string): void {
  if (!lines.includes(line)) {
    lines.push(line);
  }
}

/** Collect config-layer findings for explicit plugin load paths before runtime load. */
export async function collectPluginLoadPathFindings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const loadPaths = params.cfg.plugins?.load?.paths;
  if (!Array.isArray(loadPaths) || loadPaths.length === 0) {
    return [];
  }

  const env = params.env ?? process.env;
  const workspaceDir =
    resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg)) ?? undefined;
  const findings: SecurityAuditFinding[] = [];
  const grouped = new Map<
    string,
    { severity: SecurityAuditFinding["severity"]; lines: string[]; remediation?: string }
  >();

  const recordGrouped = (entry: {
    checkId: string;
    severity: SecurityAuditFinding["severity"];
    line: string;
    remediation?: string;
  }) => {
    const bucket = grouped.get(entry.checkId) ?? {
      severity: entry.severity,
      lines: [],
      remediation: entry.remediation,
    };
    bucket.severity =
      bucket.severity === "critical" || entry.severity === "critical" ? "critical" : entry.severity;
    pushLine(bucket.lines, entry.line);
    bucket.remediation ??= entry.remediation;
    grouped.set(entry.checkId, bucket);
  };

  recordGrouped({
    checkId: "plugins.load_paths.trust_boundary",
    severity: "info",
    line: `Configured explicit plugin load paths (${loadPaths.length}): ${loadPaths.join(", ")}.`,
    remediation:
      "Treat plugins.load.paths as an operator-selected trust boundary; keep paths owned by you, pin plugins.allow, and prefer managed installs under the state extensions root.",
  });

  for (const hit of scanBundledPluginLoadPathMigrations(params.cfg, env)) {
    recordGrouped({
      checkId: "plugins.load_paths.bundled_alias",
      severity: "warn",
      line: `${hit.fromPath} aliases bundled plugin "${hit.pluginId}" already shipped by OpenClaw (${hit.toPath}).`,
      remediation: 'Run "openclaw doctor --fix" to remove redundant bundled plugin load paths.',
    });
  }

  const discovery = discoverConfiguredPluginLoadPaths({
    loadPaths,
    workspaceDir,
    env,
  });
  for (const diagnostic of discovery.diagnostics) {
    const classified = classifyDiscoveryDiagnostic(diagnostic.message);
    if (!classified) {
      continue;
    }
    recordGrouped({
      checkId: classified.checkId,
      severity: classified.severity,
      line: diagnostic.source ? `${diagnostic.source}: ${diagnostic.message}` : diagnostic.message,
      remediation:
        classified.checkId === "plugins.load_paths.world_writable"
          ? "Tighten directory permissions (for example chmod 755) or move plugin sources out of world-writable locations."
          : classified.checkId === "plugins.load_paths.suspicious_ownership"
            ? "Ensure plugin load paths are owned by the gateway operator account."
            : classified.checkId === "plugins.load_paths.missing"
              ? "Remove missing entries or fix plugins.load.paths to point at existing plugin directories/files."
              : undefined,
    });
  }

  for (const rawPath of loadPaths) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      continue;
    }
    const resolved = resolveUserPath(rawPath.trim(), env);
    if (isProbablySyncedPath(resolved)) {
      recordGrouped({
        checkId: "plugins.load_paths.synced_folder",
        severity: "warn",
        line: `${rawPath} resolves under a synced-folder path (${resolved}).`,
        remediation:
          "Avoid loading plugins from cloud-synced directories; synced paths can change ownership and contents unexpectedly.",
      });
    }

    const perms = await inspectPathPermissions(resolved, {
      env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) {
      recordGrouped({
        checkId: "plugins.load_paths.missing",
        severity: "warn",
        line: `${rawPath} (${resolved}) is not accessible for permission inspection.`,
        remediation: "Verify the path exists and is readable by the gateway operator.",
      });
      continue;
    }
    if (perms.worldWritable) {
      recordGrouped({
        checkId: "plugins.load_paths.world_writable",
        severity: "critical",
        line: `${rawPath}: ${formatPermissionDetail(resolved, perms)}.`,
        remediation:
          "Tighten directory permissions (for example chmod 755) or move plugin sources out of world-writable locations.",
      });
    } else if (perms.groupWritable) {
      recordGrouped({
        checkId: "plugins.load_paths.group_writable",
        severity: "warn",
        line: `${rawPath}: ${formatPermissionDetail(resolved, perms)}.`,
        remediation: "Restrict group write access on plugin load paths when possible.",
      });
    }

    const parentDir = path.dirname(resolved);
    if (parentDir !== resolved) {
      const parentPerms = await inspectPathPermissions(parentDir, {
        env,
        platform: params.platform,
        exec: params.execIcacls,
      });
      if (parentPerms.ok && parentPerms.worldWritable) {
        recordGrouped({
          checkId: "plugins.load_paths.parent_world_writable",
          severity: "warn",
          line: `${rawPath} parent directory is world-writable (${parentDir}).`,
          remediation:
            "Move plugin sources out of world-writable parent directories or tighten parent permissions.",
        });
      }
    }
  }

  const titles: Record<string, string> = {
    "plugins.load_paths.trust_boundary": "Explicit plugin load paths configured",
    "plugins.load_paths.world_writable": "Plugin load path is world-writable",
    "plugins.load_paths.group_writable": "Plugin load path is group-writable",
    "plugins.load_paths.parent_world_writable":
      "Plugin load path parent directory is world-writable",
    "plugins.load_paths.suspicious_ownership": "Plugin load path has suspicious ownership",
    "plugins.load_paths.source_escapes_root": "Plugin load path source escapes plugin root",
    "plugins.load_paths.missing": "Plugin load path is missing or inaccessible",
    "plugins.load_paths.bundled_alias": "Plugin load path aliases a bundled plugin",
    "plugins.load_paths.blocked_candidate": "Plugin load path candidate was blocked",
    "plugins.load_paths.synced_folder": "Plugin load path looks like a synced folder",
  };

  for (const [checkId, bucket] of grouped.entries()) {
    findings.push({
      checkId,
      severity: bucket.severity,
      title: titles[checkId] ?? "Plugin load path risk detected",
      detail: bucket.lines.map((line) => `- ${line}`).join("\n"),
      ...(bucket.remediation ? { remediation: bucket.remediation } : {}),
    });
  }

  return findings;
}
