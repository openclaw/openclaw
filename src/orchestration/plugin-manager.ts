import type { OpenClawConfig } from "../config/config.js";
import { parseSemver } from "../infra/runtime-guard.js";
import { disablePluginInConfig } from "../plugins/disable.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "../plugins/discovery.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { appendAuditEvent } from "./audit-trail.js";
import { assertPolicyGate, type Role } from "./policy-gates.js";

export const PLATFORM_CONTRACT = "openclaw.plugin-api";

export type PluginCompatibility = {
  ok: boolean;
  reasons: string[];
};

export type ManagedPlugin = PluginCandidate & {
  compatibility: PluginCompatibility;
};

function resolveContract(candidate: PluginCandidate): string | undefined {
  const raw = candidate.packageManifest as Record<string, unknown> | undefined;
  const contract = raw?.["platformContract"];
  return typeof contract === "string" ? contract.trim() : undefined;
}

function resolveMinVersion(candidate: PluginCandidate): string | undefined {
  const raw = candidate.packageManifest as Record<string, unknown> | undefined;
  const version = raw?.["platformMinVersion"];
  return typeof version === "string" ? version.trim() : undefined;
}

export function checkPluginCompatibility(candidate: PluginCandidate, platformVersion: string): PluginCompatibility {
  const reasons: string[] = [];

  const contract = resolveContract(candidate);
  if (contract && contract !== PLATFORM_CONTRACT) {
    reasons.push(`Unsupported platform contract: ${contract}`);
  }

  const minVersionRaw = resolveMinVersion(candidate);
  if (minVersionRaw) {
    const minVersion = parseSemver(minVersionRaw);
    const current = parseSemver(platformVersion);
    if (!minVersion || !current) {
      reasons.push(`Invalid semver for compatibility check (min=${minVersionRaw}, current=${platformVersion})`);
    } else if (
      current.major < minVersion.major ||
      (current.major === minVersion.major && current.minor < minVersion.minor) ||
      (current.major === minVersion.major &&
        current.minor === minVersion.minor &&
        current.patch < minVersion.patch)
    ) {
      reasons.push(`Requires platform >= ${minVersionRaw}, current is ${platformVersion}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export class PluginManagerMvp {
  constructor(
    private readonly params: {
      platformVersion: string;
      auditFilePath?: string;
    },
  ) {}

  list(params: { workspaceDir?: string; extraPaths?: string[] }): ManagedPlugin[] {
    const result = discoverOpenClawPlugins(params);
    return result.candidates.map((candidate) => {
      const compatibility = checkPluginCompatibility(candidate, this.params.platformVersion);
      if (!compatibility.ok && this.params.auditFilePath) {
        appendAuditEvent(this.params.auditFilePath, {
          type: "plugin.compatibility_failed",
          pluginId: candidate.idHint,
          reason: compatibility.reasons.join("; "),
        });
      }
      if (this.params.auditFilePath) {
        appendAuditEvent(this.params.auditFilePath, {
          type: "plugin.discovered",
          pluginId: candidate.idHint,
          meta: { source: candidate.source, origin: candidate.origin },
        });
      }
      return { ...candidate, compatibility };
    });
  }

  enable(params: {
    cfg: OpenClawConfig;
    pluginId: string;
    actor?: string;
    actorRole?: Role;
  }) {
    assertPolicyGate({
      action: "plugin.enable",
      actor: params.actor,
      actorRole: params.actorRole,
      auditFilePath: this.params.auditFilePath,
    });
    const out = enablePluginInConfig(params.cfg, params.pluginId);
    if (this.params.auditFilePath) {
      appendAuditEvent(this.params.auditFilePath, {
        type: "plugin.enable",
        actor: params.actor,
        pluginId: params.pluginId,
        meta: { enabled: out.enabled, reason: out.reason },
      });
    }
    return out;
  }

  disable(params: {
    cfg: OpenClawConfig;
    pluginId: string;
    actor?: string;
    actorRole?: Role;
  }) {
    assertPolicyGate({
      action: "plugin.disable",
      actor: params.actor,
      actorRole: params.actorRole,
      auditFilePath: this.params.auditFilePath,
    });
    const out = disablePluginInConfig(params.cfg, params.pluginId);
    if (this.params.auditFilePath) {
      appendAuditEvent(this.params.auditFilePath, {
        type: "plugin.disable",
        actor: params.actor,
        pluginId: params.pluginId,
        meta: { disabled: out.disabled, reason: out.reason },
      });
    }
    return out;
  }
}
