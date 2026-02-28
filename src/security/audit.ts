import { isIP } from "node:net";
import path from "node:path";
import { resolveSandboxConfigForAgent } from "../agents/sandbox.js";
import { execDockerRaw } from "../agents/sandbox/docker.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { resolveBrowserControlAuth } from "../browser/control-auth.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveGatewayProbeAuth } from "../gateway/probe-auth.js";
import { probeGateway } from "../gateway/probe.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../infra/exec-safe-bin-runtime-policy.js";
import { normalizeTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectExposureMatrixFindings,
  collectGatewayHttpNoAuthFindings,
  collectGatewayHttpSessionKeyOverrideFindings,
  collectHooksHardeningFindings,
  collectIncludeFilePermFindings,
  collectInstalledSkillsCodeSafetyFindings,
  collectLikelyMultiUserSetupFindings,
  collectSandboxBrowserHashLabelFindings,
  collectMinimalProfileOverrideFindings,
  collectModelHygieneFindings,
  collectNodeDangerousAllowCommandFindings,
  collectNodeDenyCommandPatternFindings,
  collectSmallModelRiskFindings,
  collectSandboxDangerousConfigFindings,
  collectSandboxDockerNoopFindings,
  collectPluginsTrustFindings,
  collectSecretsInConfigFindings,
  collectPluginsCodeSafetyFindings,
  collectStateDeepFilesystemFindings,
  collectSyncedFolderFindings,
  readConfigSnapshotForAudit,
} from "./audit-extra.js";
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
} from "./audit-fs.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "./dangerous-tools.js";
import type { ExecFn } from "./windows-acl.js";

export type SecurityAuditSeverity = "info" | "warn" | "critical";

export type SecurityAuditFinding = {
  checkId: string;
  severity: SecurityAuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
};

export type SecurityAuditSummary = {
  critical: number;
  warn: number;
  info: number;
};

export type SecurityAuditReport = {
  ts: number;
  summary: SecurityAuditSummary;
  findings: SecurityAuditFinding[];
  deep?: {
    gateway?: {
      attempted: boolean;
      url: string | null;
      ok: boolean;
      error: string | null;
      close?: { code: number; reason: string } | null;
    };
  };
};

export type SecurityAuditOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deep?: boolean;
  includeFilesystem?: boolean;
  includeChannelSecurity?: boolean;
  /** Override where to check state (default: resolveStateDir()). */
  stateDir?: string;
  /** Override config path check (default: resolveConfigPath()). */
  configPath?: string;
  /** Time limit for deep gateway probe. */
  deepTimeoutMs?: number;
  /** Dependency injection for tests. */
  plugins?: ReturnType<typeof listChannelPlugins>;
  /** Dependency injection for tests. */
  probeGatewayFn?: typeof probeGateway;
  /** Dependency injection for tests (Windows ACL checks). */
  execIcacls?: ExecFn;
  /** Dependency injection for tests (Docker label checks). */
  execDockerRawFn?: typeof execDockerRaw;
};

function countBySeverity(findings: SecurityAuditFinding[]): SecurityAuditSummary {
  let critical = 0;
  let warn = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "critical") {
      critical += 1;
    } else if (f.severity === "warn") {
      warn += 1;
    } else {
      info += 1;
    }
  }
  return { critical, warn, info };
}

function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((v) => String(v).trim()).filter(Boolean);
}

async function collectFilesystemFindings(params: {
  stateDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  const stateDirPerms = await inspectPathPermissions(params.stateDir, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (stateDirPerms.ok) {
    if (stateDirPerms.isSymlink) {
      findings.push({
        checkId: "fs.state_dir.symlink",
        severity: "warn",
        title: "State dir is a symlink",
        detail: `${params.stateDir} is a symlink; treat this as an extra trust boundary.`,
      });
    }
    if (stateDirPerms.worldWritable) {
      findings.push({
        checkId: "fs.state_dir.perms_world_writable",
        severity: "critical",
        title: "State dir is world-writable",
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; other users can write into your OpenClaw state.`,
        remediation: formatPermissionRemediation({
          targetPath: params.stateDir,
          perms: stateDirPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (stateDirPerms.groupWritable) {
      findings.push({
        checkId: "fs.state_dir.perms_group_writable",
        severity: "warn",
        title: "State dir is group-writable",
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; group users can write into your OpenClaw state.`,
        remediation: formatPermissionRemediation({
          targetPath: params.stateDir,
          perms: stateDirPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (stateDirPerms.groupReadable || stateDirPerms.worldReadable) {
      findings.push({
        checkId: "fs.state_dir.perms_readable",
        severity: "warn",
        title: "State dir is readable by others",
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; consider restricting to 700.`,
        remediation: formatPermissionRemediation({
          targetPath: params.stateDir,
          perms: stateDirPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    }
  }

  const configPerms = await inspectPathPermissions(params.configPath, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (configPerms.ok) {
    const skipReadablePermWarnings = configPerms.isSymlink;
    if (configPerms.isSymlink) {
      findings.push({
        checkId: "fs.config.symlink",
        severity: "warn",
        title: "Config file is a symlink",
        detail: `${params.configPath} is a symlink; make sure you trust its target.`,
      });
    }
    if (configPerms.worldWritable || configPerms.groupWritable) {
      findings.push({
        checkId: "fs.config.perms_writable",
        severity: "critical",
        title: "Config file is writable by others",
        detail: `${formatPermissionDetail(params.configPath, configPerms)}; another user could change gateway/auth/tool policies.`,
        remediation: formatPermissionRemediation({
          targetPath: params.configPath,
          perms: configPerms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (!skipReadablePermWarnings && configPerms.worldReadable) {
      findings.push({
        checkId: "fs.config.perms_world_readable",
        severity: "critical",
        title: "Config file is world-readable",
        detail: `${formatPermissionDetail(params.configPath, configPerms)}; config can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: params.configPath,
          perms: configPerms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (!skipReadablePermWarnings && configPerms.groupReadable) {
      findings.push({
        checkId: "fs.config.perms_group_readable",
        severity: "warn",
        title: "Config file is group-readable",
        detail: `${formatPermissionDetail(params.configPath, configPerms)}; config can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: params.configPath,
          perms: configPerms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    }
  }

  return findings;
}

function collectGatewayConfigFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode, env });
  const controlUiEnabled = cfg.gateway?.controlUi?.enabled !== false;
  const controlUiAllowedOrigins = (cfg.gateway?.controlUi?.allowedOrigins ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const dangerouslyAllowHostHeaderOriginFallback =
    cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
  const trustedProxies = Array.isArray(cfg.gateway?.trustedProxies)
    ? cfg.gateway.trustedProxies
    : [];
  const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
  const hasPassword = typeof auth.password === "string" && auth.password.trim().length > 0;
  const hasSharedSecret =
    (auth.mode === "token" && hasToken) || (auth.mode === "password" && hasPassword);
  const hasTailscaleAuth = auth.allowTailscale && tailscaleMode === "serve";
  const hasGatewayAuth = hasSharedSecret || hasTailscaleAuth;
  const allowRealIpFallback = cfg.gateway?.allowRealIpFallback === true;
  const mdnsMode = cfg.discovery?.mdns?.mode ?? "minimal";

  // HTTP /tools/invoke is intended for narrow automation, not session orchestration/admin operations.
  // If operators opt-in to re-enabling these tools over HTTP, warn loudly so the choice is explicit.
  const gatewayToolsAllowRaw = Array.isArray(cfg.gateway?.tools?.allow)
    ? cfg.gateway?.tools?.allow
    : [];
  const gatewayToolsAllow = new Set(
    gatewayToolsAllowRaw
      .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
      .filter(Boolean),
  );
  const reenabledOverHttp = DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) =>
    gatewayToolsAllow.has(name),
  );
  if (reenabledOverHttp.length > 0) {
    const extraRisk = bind !== "loopback" || tailscaleMode === "funnel";
    findings.push({
      checkId: "gateway.tools_invoke_http.dangerous_allow",
      severity: extraRisk ? "critical" : "warn",
      title: "Gateway HTTP /tools/invoke re-enables dangerous tools",
      detail:
        `gateway.tools.allow includes ${reenabledOverHttp.join(", ")} which removes them from the default HTTP deny list. ` +
        "This can allow remote session spawning / control-plane actions via HTTP and increases RCE blast radius if the gateway is reachable.",
      remediation:
        "Remove these entries from gateway.tools.allow (recommended). " +
        "If you keep them enabled, keep gateway.bind loopback-only (or tailnet-only), restrict network exposure, and treat the gateway token/password as full-admin.",
    });
  }
  if (bind !== "loopback" && !hasSharedSecret && auth.mode !== "trusted-proxy") {
    findings.push({
      checkId: "gateway.bind_no_auth",
      severity: "critical",
      title: "Gateway binds beyond loopback without auth",
      detail: `gateway.bind="${bind}" but no gateway.auth token/password is configured.`,
      remediation: `Set gateway.auth (token recommended) or bind to loopback.`,
    });
  }

  if (bind === "loopback" && controlUiEnabled && trustedProxies.length === 0) {
    findings.push({
      checkId: "gateway.trusted_proxies_missing",
      severity: "warn",
      title: "Reverse proxy headers are not trusted",
      detail:
        "gateway.bind is loopback and gateway.trustedProxies is empty. " +
        "If you expose the Control UI through a reverse proxy, configure trusted proxies " +
        "so local-client checks cannot be spoofed.",
      remediation:
        "Set gateway.trustedProxies to your proxy IPs or keep the Control UI local-only.",
    });
  }

  if (bind === "loopback" && controlUiEnabled && !hasGatewayAuth) {
    findings.push({
      checkId: "gateway.loopback_no_auth",
      severity: "critical",
      title: "Gateway auth missing on loopback",
      detail:
        "gateway.bind is loopback but no gateway auth secret is configured. " +
        "If the Control UI is exposed through a reverse proxy, unauthenticated access is possible.",
      remediation: "Set gateway.auth (token recommended) or keep the Control UI local-only.",
    });
  }
  if (
    bind !== "loopback" &&
    controlUiEnabled &&
    controlUiAllowedOrigins.length === 0 &&
    !dangerouslyAllowHostHeaderOriginFallback
  ) {
    findings.push({
      checkId: "gateway.control_ui.allowed_origins_required",
      severity: "critical",
      title: "Non-loopback Control UI missing explicit allowed origins",
      detail:
        "Control UI is enabled on a non-loopback bind but gateway.controlUi.allowedOrigins is empty. " +
        "Strict origin policy requires explicit allowed origins for non-loopback deployments.",
      remediation:
        "Set gateway.controlUi.allowedOrigins to full trusted origins (for example https://control.example.com). " +
        "If your deployment intentionally relies on Host-header origin fallback, set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true.",
    });
  }
  if (dangerouslyAllowHostHeaderOriginFallback) {
    const exposed = bind !== "loopback";
    findings.push({
      checkId: "gateway.control_ui.host_header_origin_fallback",
      severity: exposed ? "critical" : "warn",
      title: "DANGEROUS: Host-header origin fallback enabled",
      detail:
        "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true enables Host-header origin fallback " +
        "for Control UI/WebChat websocket checks and weakens DNS rebinding protections.",
      remediation:
        "Disable gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback and configure explicit gateway.controlUi.allowedOrigins.",
    });
  }

  if (allowRealIpFallback) {
    const hasNonLoopbackTrustedProxy = trustedProxies.some(
      (proxy) => !isStrictLoopbackTrustedProxyEntry(proxy),
    );
    const exposed =
      bind !== "loopback" || (auth.mode === "trusted-proxy" && hasNonLoopbackTrustedProxy);
    findings.push({
      checkId: "gateway.real_ip_fallback_enabled",
      severity: exposed ? "critical" : "warn",
      title: "X-Real-IP fallback is enabled",
      detail:
        "gateway.allowRealIpFallback=true trusts X-Real-IP when trusted proxies omit X-Forwarded-For. " +
        "Misconfigured proxies that forward client-supplied X-Real-IP can spoof source IP and local-client checks.",
      remediation:
        "Keep gateway.allowRealIpFallback=false (default). Only enable this when your trusted proxy " +
        "always overwrites X-Real-IP and cannot provide X-Forwarded-For.",
    });
  }

  if (mdnsMode === "full") {
    const exposed = bind !== "loopback";
    findings.push({
      checkId: "discovery.mdns_full_mode",
      severity: exposed ? "critical" : "warn",
      title: "mDNS full mode can leak host metadata",
      detail:
        'discovery.mdns.mode="full" publishes cliPath/sshPort in local-network TXT records. ' +
        "This can reveal usernames, filesystem layout, and management ports.",
      remediation:
        'Prefer discovery.mdns.mode="minimal" (recommended) or "off", especially when gateway.bind is not loopback.',
    });
  }

  if (tailscaleMode === "funnel") {
    findings.push({
      checkId: "gateway.tailscale_funnel",
      severity: "critical",
      title: "Tailscale Funnel exposure enabled",
      detail: `gateway.tailscale.mode="funnel" exposes the Gateway publicly; keep auth strict and treat it as internet-facing.`,
      remediation: `Prefer tailscale.mode="serve" (tailnet-only) or set tailscale.mode="off".`,
    });
  } else if (tailscaleMode === "serve") {
    findings.push({
      checkId: "gateway.tailscale_serve",
      severity: "info",
      title: "Tailscale Serve exposure enabled",
      detail: `gateway.tailscale.mode="serve" exposes the Gateway to your tailnet (loopback behind Tailscale).`,
    });
  }

  if (cfg.gateway?.controlUi?.allowInsecureAuth === true) {
    findings.push({
      checkId: "gateway.control_ui.insecure_auth",
      severity: "warn",
      title: "Control UI insecure auth toggle enabled",
      detail:
        "gateway.controlUi.allowInsecureAuth=true does not bypass secure context or device identity checks; only dangerouslyDisableDeviceAuth disables Control UI device identity checks.",
      remediation: "Disable it or switch to HTTPS (Tailscale Serve) or localhost.",
    });
  }

  if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
    findings.push({
      checkId: "gateway.control_ui.device_auth_disabled",
      severity: "critical",
      title: "DANGEROUS: Control UI device auth disabled",
      detail:
        "gateway.controlUi.dangerouslyDisableDeviceAuth=true disables device identity checks for the Control UI.",
      remediation: "Disable it unless you are in a short-lived break-glass scenario.",
    });
  }

  const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(cfg);
  if (enabledDangerousFlags.length > 0) {
    findings.push({
      checkId: "config.insecure_or_dangerous_flags",
      severity: "warn",
      title: "Insecure or dangerous config flags enabled",
      detail: `Detected ${enabledDangerousFlags.length} enabled flag(s): ${enabledDangerousFlags.join(", ")}.`,
      remediation:
        "Disable these flags when not actively debugging, or keep deployment scoped to trusted/local-only networks.",
    });
  }

  const token =
    typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token.trim() : null;
  if (auth.mode === "token" && token && token.length < 24) {
    findings.push({
      checkId: "gateway.token_too_short",
      severity: "warn",
      title: "Gateway token looks short",
      detail: `gateway auth token is ${token.length} chars; prefer a long random token.`,
    });
  }

  if (auth.mode === "trusted-proxy") {
    const trustedProxies = cfg.gateway?.trustedProxies ?? [];
    const trustedProxyConfig = cfg.gateway?.auth?.trustedProxy;

    findings.push({
      checkId: "gateway.trusted_proxy_auth",
      severity: "critical",
      title: "Trusted-proxy auth mode enabled",
      detail:
        'gateway.auth.mode="trusted-proxy" delegates authentication to a reverse proxy. ' +
        "Ensure your proxy (Pomerium, Caddy, nginx) handles auth correctly and that gateway.trustedProxies " +
        "only contains IPs of your actual proxy servers.",
      remediation:
        "Verify: (1) Your proxy terminates TLS and authenticates users. " +
        "(2) gateway.trustedProxies is restricted to proxy IPs only. " +
        "(3) Direct access to the Gateway port is blocked by firewall. " +
        "See /gateway/trusted-proxy-auth for setup guidance.",
    });

    if (trustedProxies.length === 0) {
      findings.push({
        checkId: "gateway.trusted_proxy_no_proxies",
        severity: "critical",
        title: "Trusted-proxy auth enabled but no trusted proxies configured",
        detail:
          'gateway.auth.mode="trusted-proxy" but gateway.trustedProxies is empty. ' +
          "All requests will be rejected.",
        remediation: "Set gateway.trustedProxies to the IP(s) of your reverse proxy.",
      });
    }

    if (!trustedProxyConfig?.userHeader) {
      findings.push({
        checkId: "gateway.trusted_proxy_no_user_header",
        severity: "critical",
        title: "Trusted-proxy auth missing userHeader config",
        detail:
          'gateway.auth.mode="trusted-proxy" but gateway.auth.trustedProxy.userHeader is not configured.',
        remediation:
          "Set gateway.auth.trustedProxy.userHeader to the header name your proxy uses " +
          '(e.g., "x-forwarded-user", "x-pomerium-claim-email").',
      });
    }

    const allowUsers = trustedProxyConfig?.allowUsers ?? [];
    if (allowUsers.length === 0) {
      findings.push({
        checkId: "gateway.trusted_proxy_no_allowlist",
        severity: "warn",
        title: "Trusted-proxy auth allows all authenticated users",
        detail:
          "gateway.auth.trustedProxy.allowUsers is empty, so any user authenticated by your proxy can access the Gateway.",
        remediation:
          "Consider setting gateway.auth.trustedProxy.allowUsers to restrict access to specific users " +
          '(e.g., ["nick@example.com"]).',
      });
    }
  }

  if (bind !== "loopback" && auth.mode !== "trusted-proxy" && !cfg.gateway?.auth?.rateLimit) {
    findings.push({
      checkId: "gateway.auth_no_rate_limit",
      severity: "warn",
      title: "No auth rate limiting configured",
      detail:
        "gateway.bind is not loopback but no gateway.auth.rateLimit is configured. " +
        "Without rate limiting, brute-force auth attacks are not mitigated.",
      remediation:
        "Set gateway.auth.rateLimit (e.g. { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 }).",
    });
  }

  return findings;
}

// Keep this stricter than isLoopbackAddress on purpose: this check is for
// trust boundaries, so only explicit localhost proxy hops are treated as local.
function isStrictLoopbackTrustedProxyEntry(entry: string): boolean {
  const candidate = entry.trim();
  if (!candidate) {
    return false;
  }
  if (!candidate.includes("/")) {
    return candidate === "127.0.0.1" || candidate.toLowerCase() === "::1";
  }

  const [rawIp, rawPrefix] = candidate.split("/", 2);
  if (!rawIp || !rawPrefix) {
    return false;
  }
  const ipVersion = isIP(rawIp.trim());
  const prefix = Number.parseInt(rawPrefix.trim(), 10);
  if (!Number.isInteger(prefix)) {
    return false;
  }
  if (ipVersion === 4) {
    return rawIp.trim() === "127.0.0.1" && prefix === 32;
  }
  if (ipVersion === 6) {
    return prefix === 128 && rawIp.trim().toLowerCase() === "::1";
  }
  return false;
}

function collectBrowserControlFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  let resolved: ReturnType<typeof resolveBrowserConfig>;
  try {
    resolved = resolveBrowserConfig(cfg.browser, cfg);
  } catch (err) {
    findings.push({
      checkId: "browser.control_invalid_config",
      severity: "warn",
      title: "Browser control config looks invalid",
      detail: String(err),
      remediation: `Fix browser.cdpUrl in ${resolveConfigPath()} and re-run "${formatCliCommand("openclaw security audit --deep")}".`,
    });
    return findings;
  }

  if (!resolved.enabled) {
    return findings;
  }

  const browserAuth = resolveBrowserControlAuth(cfg, env);
  if (!browserAuth.token && !browserAuth.password) {
    findings.push({
      checkId: "browser.control_no_auth",
      severity: "critical",
      title: "Browser control has no auth",
      detail:
        "Browser control HTTP routes are enabled but no gateway.auth token/password is configured. " +
        "Any local process (or SSRF to loopback) can call browser control endpoints.",
      remediation:
        "Set gateway.auth.token (recommended) or gateway.auth.password so browser control HTTP routes require authentication. Restarting the gateway will auto-generate gateway.auth.token when browser control is enabled.",
    });
  }

  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.cdpIsLoopback) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(profile.cdpUrl);
    } catch {
      continue;
    }
    if (url.protocol === "http:") {
      findings.push({
        checkId: "browser.remote_cdp_http",
        severity: "warn",
        title: "Remote CDP uses HTTP",
        detail: `browser profile "${name}" uses http CDP (${profile.cdpUrl}); this is OK only if it's tailnet-only or behind an encrypted tunnel.`,
        remediation: `Prefer HTTPS/TLS or a tailnet-only endpoint for remote CDP.`,
      });
    }
  }

  return findings;
}

function collectLoggingFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const redact = cfg.logging?.redactSensitive;
  if (redact !== "off") {
    return [];
  }
  return [
    {
      checkId: "logging.redact_off",
      severity: "warn",
      title: "Tool summary redaction is disabled",
      detail: `logging.redactSensitive="off" can leak secrets into logs and status output.`,
      remediation: `Set logging.redactSensitive="tools".`,
    },
  ];
}

function collectElevatedFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const enabled = cfg.tools?.elevated?.enabled;
  const allowFrom = cfg.tools?.elevated?.allowFrom ?? {};
  const anyAllowFromKeys = Object.keys(allowFrom).length > 0;

  if (enabled === false) {
    return findings;
  }
  if (!anyAllowFromKeys) {
    return findings;
  }

  for (const [provider, list] of Object.entries(allowFrom)) {
    const normalized = normalizeAllowFromList(list);
    if (normalized.includes("*")) {
      findings.push({
        checkId: `tools.elevated.allowFrom.${provider}.wildcard`,
        severity: "critical",
        title: "Elevated exec allowlist contains wildcard",
        detail: `tools.elevated.allowFrom.${provider} includes "*" which effectively approves everyone on that channel for elevated mode.`,
      });
    } else if (normalized.length > 25) {
      findings.push({
        checkId: `tools.elevated.allowFrom.${provider}.large`,
        severity: "warn",
        title: "Elevated exec allowlist is large",
        detail: `tools.elevated.allowFrom.${provider} has ${normalized.length} entries; consider tightening elevated access.`,
      });
    }
  }

  return findings;
}

function collectExecRuntimeFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const globalExecHost = cfg.tools?.exec?.host;
  const defaultSandboxMode = resolveSandboxConfigForAgent(cfg).mode;
  const defaultHostIsExplicitSandbox = globalExecHost === "sandbox";

  if (defaultHostIsExplicitSandbox && defaultSandboxMode === "off") {
    findings.push({
      checkId: "tools.exec.host_sandbox_no_sandbox_defaults",
      severity: "warn",
      title: "Exec host is sandbox but sandbox mode is off",
      detail:
        "tools.exec.host is explicitly set to sandbox while agents.defaults.sandbox.mode=off. " +
        "In this mode, exec runs directly on the gateway host.",
      remediation:
        'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or set tools.exec.host to "gateway" with approvals.',
    });
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const riskyAgents = agents
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.tools?.exec?.host === "sandbox" &&
        resolveSandboxConfigForAgent(cfg, entry.id).mode === "off",
    )
    .map((entry) => entry.id)
    .slice(0, 5);

  if (riskyAgents.length > 0) {
    findings.push({
      checkId: "tools.exec.host_sandbox_no_sandbox_agents",
      severity: "warn",
      title: "Agent exec host uses sandbox while sandbox mode is off",
      detail:
        `agents.list.*.tools.exec.host is set to sandbox for: ${riskyAgents.join(", ")}. ` +
        "With sandbox mode off, exec runs directly on the gateway host.",
      remediation:
        'Enable sandbox mode for these agents (`agents.list[].sandbox.mode`) or set their tools.exec.host to "gateway".',
    });
  }

  const normalizeConfiguredSafeBins = (entries: unknown): string[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return Array.from(
      new Set(
        entries
          .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
          .filter((entry) => entry.length > 0),
      ),
    ).toSorted();
  };
  const normalizeConfiguredTrustedDirs = (entries: unknown): string[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return normalizeTrustedSafeBinDirs(
      entries.filter((entry): entry is string => typeof entry === "string"),
    );
  };
  const classifyRiskySafeBinTrustedDir = (entry: string): string | null => {
    const raw = entry.trim();
    if (!raw) {
      return null;
    }
    if (!path.isAbsolute(raw)) {
      return "relative path (trust boundary depends on process cwd)";
    }
    const normalized = path.resolve(raw).replace(/\\/g, "/").toLowerCase();
    if (
      normalized === "/tmp" ||
      normalized.startsWith("/tmp/") ||
      normalized === "/var/tmp" ||
      normalized.startsWith("/var/tmp/") ||
      normalized === "/private/tmp" ||
      normalized.startsWith("/private/tmp/")
    ) {
      return "temporary directory is mutable and easy to poison";
    }
    if (
      normalized === "/usr/local/bin" ||
      normalized === "/opt/homebrew/bin" ||
      normalized === "/opt/local/bin" ||
      normalized === "/home/linuxbrew/.linuxbrew/bin"
    ) {
      return "package-manager bin directory (often user-writable)";
    }
    if (
      normalized.startsWith("/users/") ||
      normalized.startsWith("/home/") ||
      normalized.includes("/.local/bin")
    ) {
      return "home-scoped bin directory (typically user-writable)";
    }
    if (/^[a-z]:\/users\//.test(normalized)) {
      return "home-scoped bin directory (typically user-writable)";
    }
    return null;
  };

  const globalExec = cfg.tools?.exec;
  const riskyTrustedDirHits: string[] = [];
  const collectRiskyTrustedDirHits = (scopePath: string, entries: unknown): void => {
    for (const entry of normalizeConfiguredTrustedDirs(entries)) {
      const reason = classifyRiskySafeBinTrustedDir(entry);
      if (!reason) {
        continue;
      }
      riskyTrustedDirHits.push(`- ${scopePath}.safeBinTrustedDirs: ${entry} (${reason})`);
    }
  };
  collectRiskyTrustedDirHits("tools.exec", globalExec?.safeBinTrustedDirs);
  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    collectRiskyTrustedDirHits(
      `agents.list.${entry.id}.tools.exec`,
      entry.tools?.exec?.safeBinTrustedDirs,
    );
  }

  const interpreterHits: string[] = [];
  const globalSafeBins = normalizeConfiguredSafeBins(globalExec?.safeBins);
  if (globalSafeBins.length > 0) {
    const merged = resolveMergedSafeBinProfileFixtures({ global: globalExec }) ?? {};
    const interpreters = listInterpreterLikeSafeBins(globalSafeBins).filter((bin) => !merged[bin]);
    if (interpreters.length > 0) {
      interpreterHits.push(`- tools.exec.safeBins: ${interpreters.join(", ")}`);
    }
  }

  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const agentExec = entry.tools?.exec;
    const agentSafeBins = normalizeConfiguredSafeBins(agentExec?.safeBins);
    if (agentSafeBins.length === 0) {
      continue;
    }
    const merged =
      resolveMergedSafeBinProfileFixtures({
        global: globalExec,
        local: agentExec,
      }) ?? {};
    const interpreters = listInterpreterLikeSafeBins(agentSafeBins).filter((bin) => !merged[bin]);
    if (interpreters.length === 0) {
      continue;
    }
    interpreterHits.push(
      `- agents.list.${entry.id}.tools.exec.safeBins: ${interpreters.join(", ")}`,
    );
  }

  if (interpreterHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bins_interpreter_unprofiled",
      severity: "warn",
      title: "safeBins includes interpreter/runtime binaries without explicit profiles",
      detail:
        `Detected interpreter-like safeBins entries missing explicit profiles:\n${interpreterHits.join("\n")}\n` +
        "These entries can turn safeBins into a broad execution surface when used with permissive argv profiles.",
      remediation:
        "Remove interpreter/runtime bins from safeBins (prefer allowlist entries) or define hardened tools.exec.safeBinProfiles.<bin> rules.",
    });
  }

  if (riskyTrustedDirHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bin_trusted_dirs_risky",
      severity: "warn",
      title: "safeBinTrustedDirs includes risky mutable directories",
      detail:
        `Detected risky safeBinTrustedDirs entries:\n${riskyTrustedDirHits.slice(0, 10).join("\n")}` +
        (riskyTrustedDirHits.length > 10
          ? `\n- +${riskyTrustedDirHits.length - 10} more entries.`
          : ""),
      remediation:
        "Prefer root-owned immutable bins, keep default trust dirs (/bin, /usr/bin), and avoid trusting temporary/home/package-manager paths unless tightly controlled.",
    });
  }

  return findings;
}

async function maybeProbeGateway(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  probe: typeof probeGateway;
}): Promise<SecurityAuditReport["deep"]> {
  const connection = buildGatewayConnectionDetails({ config: params.cfg });
  const url = connection.url;
  const isRemoteMode = params.cfg.gateway?.mode === "remote";
  const remoteUrlRaw =
    typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url.trim() : "";
  const remoteUrlMissing = isRemoteMode && !remoteUrlRaw;

  const auth =
    !isRemoteMode || remoteUrlMissing
      ? resolveGatewayProbeAuth({ cfg: params.cfg, env: params.env, mode: "local" })
      : resolveGatewayProbeAuth({ cfg: params.cfg, env: params.env, mode: "remote" });
  const res = await params.probe({ url, auth, timeoutMs: params.timeoutMs }).catch((err) => ({
    ok: false,
    url,
    connectLatencyMs: null,
    error: String(err),
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  }));

  return {
    gateway: {
      attempted: true,
      url,
      ok: res.ok,
      error: res.ok ? null : res.error,
      close: res.close ? { code: res.close.code, reason: res.close.reason } : null,
    },
  };
}

export async function runSecurityAudit(opts: SecurityAuditOptions): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];
  const cfg = opts.config;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const execIcacls = opts.execIcacls;
  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const configPath = opts.configPath ?? resolveConfigPath(env, stateDir);

  findings.push(...collectAttackSurfaceSummaryFindings(cfg));
  findings.push(...collectSyncedFolderFindings({ stateDir, configPath }));

  findings.push(...collectGatewayConfigFindings(cfg, env));
  findings.push(...collectBrowserControlFindings(cfg, env));
  findings.push(...collectLoggingFindings(cfg));
  findings.push(...collectElevatedFindings(cfg));
  findings.push(...collectExecRuntimeFindings(cfg));
  findings.push(...collectHooksHardeningFindings(cfg, env));
  findings.push(...collectGatewayHttpNoAuthFindings(cfg, env));
  findings.push(...collectGatewayHttpSessionKeyOverrideFindings(cfg));
  findings.push(...collectSandboxDockerNoopFindings(cfg));
  findings.push(...collectSandboxDangerousConfigFindings(cfg));
  findings.push(...collectNodeDenyCommandPatternFindings(cfg));
  findings.push(...collectNodeDangerousAllowCommandFindings(cfg));
  findings.push(...collectMinimalProfileOverrideFindings(cfg));
  findings.push(...collectSecretsInConfigFindings(cfg));
  findings.push(...collectModelHygieneFindings(cfg));
  findings.push(...collectSmallModelRiskFindings({ cfg, env }));
  findings.push(...collectExposureMatrixFindings(cfg));
  findings.push(...collectLikelyMultiUserSetupFindings(cfg));

  const configSnapshot =
    opts.includeFilesystem !== false
      ? await readConfigSnapshotForAudit({ env, configPath }).catch(() => null)
      : null;

  if (opts.includeFilesystem !== false) {
    findings.push(
      ...(await collectFilesystemFindings({
        stateDir,
        configPath,
        env,
        platform,
        execIcacls,
      })),
    );
    if (configSnapshot) {
      findings.push(
        ...(await collectIncludeFilePermFindings({ configSnapshot, env, platform, execIcacls })),
      );
    }
    findings.push(
      ...(await collectStateDeepFilesystemFindings({ cfg, env, stateDir, platform, execIcacls })),
    );
    findings.push(
      ...(await collectSandboxBrowserHashLabelFindings({
        execDockerRawFn: opts.execDockerRawFn,
      })),
    );
    findings.push(...(await collectPluginsTrustFindings({ cfg, stateDir })));
    if (opts.deep === true) {
      findings.push(...(await collectPluginsCodeSafetyFindings({ stateDir })));
      findings.push(...(await collectInstalledSkillsCodeSafetyFindings({ cfg, stateDir })));
    }
  }

  if (opts.includeChannelSecurity !== false) {
    const plugins = opts.plugins ?? listChannelPlugins();
    findings.push(...(await collectChannelSecurityFindings({ cfg, plugins })));
  }

  const deep =
    opts.deep === true
      ? await maybeProbeGateway({
          cfg,
          env,
          timeoutMs: Math.max(250, opts.deepTimeoutMs ?? 5000),
          probe: opts.probeGatewayFn ?? probeGateway,
        })
      : undefined;

  if (deep?.gateway?.attempted && !deep.gateway.ok) {
    findings.push({
      checkId: "gateway.probe_failed",
      severity: "warn",
      title: "Gateway probe failed (deep)",
      detail: deep.gateway.error ?? "gateway unreachable",
      remediation: `Run "${formatCliCommand("openclaw status --all")}" to debug connectivity/auth, then re-run "${formatCliCommand("openclaw security audit --deep")}".`,
    });
  }

  const summary = countBySeverity(findings);
  return { ts: Date.now(), summary, findings, deep };
}
