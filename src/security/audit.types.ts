import type { PermissionExec as ExecFn } from "@openclaw/fs-safe/advanced";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";

type ExecDockerRawFn = typeof import("../agents/sandbox/docker.js").execDockerRaw;
type ProbeGatewayFn = typeof import("../gateway/probe.js").probeGateway;
type SecurityAuditExplicitGatewayAuth = {
  token?: string;
  password?: string;
};
type SecurityAuditGatewayAuthOverride = Pick<GatewayAuthConfig, "mode" | "token" | "password">;

export type SecurityAuditOptions = {
  config: OpenClawConfig;
  /** Cancel a caller-owned read without turning it into a failed probe finding. */
  signal?: AbortSignal;
  sourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deep?: boolean;
  includeFilesystem?: boolean;
  /** Override where to check state (default: resolveStateDir()). */
  stateDir?: string;
  /** Override config path check (default: resolveConfigPath()). */
  configPath?: string;
  /** Time limit for deep gateway probe. */
  deepTimeoutMs?: number;
  /** Dependency injection for tests. */
  plugins?: ChannelPlugin[];
  /** Whether to import plugin modules to discover plugin security audit collectors. */
  loadPluginSecurityCollectors?: boolean;
  /** Dependency injection for tests (Windows ACL checks). */
  execIcacls?: ExecFn;
  /** Dependency injection for tests (Docker label checks). */
  execDockerRawFn?: ExecDockerRawFn;
  /** Optional preloaded config snapshot to skip audit-time config file reads. */
  configSnapshot?: ConfigFileSnapshot | null;
  /** Optional explicit auth for deep gateway probe. */
  deepProbeAuth?: SecurityAuditExplicitGatewayAuth;
  /** Optional explicit Gateway auth mode/secret for config-only audit checks. */
  auditGatewayAuthOverride?: SecurityAuditGatewayAuthOverride;
  /** Override workspace used for workspace plugin discovery. */
  workspaceDir?: string;
  /** Dependency injection for tests. */
  probeGatewayFn?: ProbeGatewayFn;
};

type SecurityAuditSeverity = "info" | "warn" | "critical";

export type SecurityAuditFinding = {
  checkId: string;
  severity: SecurityAuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
};

export type SecurityAuditSuppressedFinding = SecurityAuditFinding & {
  suppression: {
    reason?: string;
  };
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
  suppressedFindings?: SecurityAuditSuppressedFinding[];
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
