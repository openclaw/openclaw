import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovals, type ExecApprovalsFile } from "../infra/exec-approvals.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.types.js";
import { note } from "../terminal/note.js";

const DEFAULT_OPENCLAW_HOME = "/Users/hide_aibo";
const WRAPPER_LIB_PATH = "/Users/hide_aibo/.local/bin/oc-wrapper-lib";

export type CoreHarnessWarning = {
  code: string;
  severity: "info" | "warn" | "error";
  category: "new" | "existing-consolidate" | "resolver-bug-followup";
  summary: string;
  what_to_do_now: string;
  safe_to_ignore_today: boolean;
};

export type CoreHarnessSummary = {
  effectiveHome: {
    path: string;
    source: "env" | "fallback";
    processHome: string | null;
    isolatedProcessHome: boolean;
  };
  config: {
    path: string;
    readable: boolean;
    issues: Array<{ path: string; message: string }>;
  };
  sandbox: {
    mode: string;
    scope: string;
    workspaceAccess: string;
  };
  elevated: {
    enabled: boolean;
    wildcardAllowFrom: string[];
  };
  approvals: {
    totalEntries: number;
    allowAlwaysEntries: number;
    opaqueCommandEntries: number;
    staleOrUnknownLastUsedEntries: number;
  };
  wrappers: {
    openclawSetupAlias: boolean;
    homeResolver: boolean;
  };
  warnings: CoreHarnessWarning[];
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function resolveCoreHarnessHome(
  env: NodeJS.ProcessEnv = process.env,
): CoreHarnessSummary["effectiveHome"] {
  const envHome = normalizeNonEmptyString(env.OPENCLAW_HOME);
  return {
    path: envHome ?? DEFAULT_OPENCLAW_HOME,
    source: envHome ? "env" : "fallback",
    processHome: normalizeNonEmptyString(env.HOME),
    isolatedProcessHome: isIsolatedCodexHome(env.HOME),
  };
}

export function isIsolatedCodexHome(value: unknown): boolean {
  const candidate = normalizeNonEmptyString(value);
  if (!candidate) {
    return false;
  }
  const normalized = candidate.split(path.sep).join("/");
  return (
    normalized.includes("/.codex") ||
    normalized.includes("/codex-") ||
    normalized.includes("/codex_") ||
    normalized.includes("/openclaw-codex") ||
    normalized.includes("/isolated/")
  );
}

function collectAllowFromWildcards(cfg: OpenClawConfig): string[] {
  const wildcards: string[] = [];
  const collect = (prefix: string, allowFrom: unknown) => {
    if (!allowFrom || typeof allowFrom !== "object" || Array.isArray(allowFrom)) {
      return;
    }
    for (const [channel, raw] of Object.entries(allowFrom)) {
      const values = Array.isArray(raw) ? raw : [];
      if (values.some((entry) => String(entry).trim() === "*")) {
        wildcards.push(`${prefix}.${channel}`);
      }
    }
  };

  collect("tools.elevated.allowFrom", cfg.tools?.elevated?.allowFrom);
  for (const agent of cfg.agents?.list ?? []) {
    collect(`agents.list.${agent.id}.tools.elevated.allowFrom`, agent.tools?.elevated?.allowFrom);
  }
  return wildcards.toSorted();
}

function collectAllowlistEntries(file: ExecApprovalsFile): ExecAllowlistEntry[] {
  const entries: ExecAllowlistEntry[] = [];
  for (const agent of Object.values(file.agents ?? {})) {
    entries.push(...(agent.allowlist ?? []));
  }
  return entries;
}

function summarizeApprovals(file: ExecApprovalsFile): CoreHarnessSummary["approvals"] {
  const entries = collectAllowlistEntries(file);
  const allowAlwaysEntries = entries.filter((entry) => entry.source === "allow-always").length;
  const opaqueCommandEntries = entries.filter(
    (entry) => entry.pattern.startsWith("=command:") && !entry.commandText?.trim(),
  ).length;
  const staleOrUnknownLastUsedEntries = entries.filter((entry) => !entry.lastUsedAt).length;
  return {
    totalEntries: entries.length,
    allowAlwaysEntries,
    opaqueCommandEntries,
    staleOrUnknownLastUsedEntries,
  };
}

function inspectWrapperCoverage(params: {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
}): CoreHarnessSummary["wrappers"] {
  if (!params.existsSync(WRAPPER_LIB_PATH)) {
    return {
      openclawSetupAlias: false,
      homeResolver: false,
    };
  }
  const body = params.readFileSync(WRAPPER_LIB_PATH, "utf8");
  return {
    openclawSetupAlias: body.includes("openclaw-setup"),
    homeResolver: body.includes("resolve_openclaw_home") && body.includes("OPENCLAW_HOME"),
  };
}

function addWarning(
  warnings: CoreHarnessWarning[],
  warning: Omit<CoreHarnessWarning, "safe_to_ignore_today"> & {
    safe_to_ignore_today?: boolean;
  },
): void {
  warnings.push({
    ...warning,
    safe_to_ignore_today:
      warning.safe_to_ignore_today ?? (warning.severity === "info" ? true : false),
  });
}

export function buildCoreHarnessSummary(params: {
  cfg: OpenClawConfig;
  configPath: string;
  sourceConfigValid?: boolean;
  configIssues?: Array<{ path: string; message: string }>;
  env?: NodeJS.ProcessEnv;
  approvals?: ExecApprovalsFile;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
}): CoreHarnessSummary {
  const env = params.env ?? process.env;
  const home = resolveCoreHarnessHome(env);
  const approvals = summarizeApprovals(params.approvals ?? loadExecApprovals());
  const wrappers = inspectWrapperCoverage({
    existsSync: params.existsSync ?? fs.existsSync,
    readFileSync: params.readFileSync ?? fs.readFileSync,
  });
  const wildcardAllowFrom = collectAllowFromWildcards(params.cfg);
  const warnings: CoreHarnessWarning[] = [];

  if (
    home.isolatedProcessHome &&
    path.resolve(home.processHome ?? os.homedir()) !== path.resolve(home.path)
  ) {
    addWarning(warnings, {
      code: "core-harness.home.isolated",
      severity: "error",
      category: "new",
      summary: "Core Harness is running from an isolated Codex-like HOME.",
      what_to_do_now:
        "OPENCLAW_HOME を実運用 home に向けて、wrapper 経由で doctor を実行してください。",
    });
  }

  if (!wrappers.openclawSetupAlias) {
    addWarning(warnings, {
      code: "core-harness.wrapper.openclaw-setup-alias-missing",
      severity: "warn",
      category: "new",
      summary: "wrapper repo aliases do not include active setup repo.",
      what_to_do_now: "oc-wrapper-lib に openclaw-setup alias を追加してください。",
    });
  }

  if (!wrappers.homeResolver) {
    addWarning(warnings, {
      code: "core-harness.wrapper.home-resolver-missing",
      severity: "warn",
      category: "new",
      summary: "wrapper home resolver is missing or not using OPENCLAW_HOME.",
      what_to_do_now: "oc-wrapper-lib の HOME 解決を OPENCLAW_HOME 優先にしてください。",
    });
  }

  if (!params.cfg.commands?.ownerAllowFrom?.length) {
    addWarning(warnings, {
      code: "core-harness.command-owner.missing",
      severity: "warn",
      category: "new",
      summary: "command owner is missing.",
      what_to_do_now: "commands.ownerAllowFrom に Hide の操作元 ID を設定してください。",
    });
  }

  if (wildcardAllowFrom.length > 0) {
    addWarning(warnings, {
      code: "core-harness.elevated.allow-from-wildcard",
      severity: "warn",
      category: "existing-consolidate",
      summary: "tools.elevated.allowFrom contains broad wildcards.",
      what_to_do_now:
        "今日は warning として確認し、Phase 2 で session id 単位へ狭める計画を作ってください。",
    });
  }

  if (approvals.allowAlwaysEntries > 0 || approvals.opaqueCommandEntries > 0) {
    addWarning(warnings, {
      code: "core-harness.exec-approvals.drift",
      severity: "warn",
      category: "existing-consolidate",
      summary: "exec-approvals.json has durable or opaque approval entries.",
      what_to_do_now: "今日は削除せず、drift report を読んで整理対象だけ選んでください。",
    });
  }

  if (wildcardAllowFrom.some((entry) => entry.endsWith(".discord"))) {
    addWarning(warnings, {
      code: "core-harness.sandbox-explain.resolver-followup",
      severity: "info",
      category: "resolver-bug-followup",
      summary: "sandbox explain resolver behavior still needs a Phase 2 follow-up.",
      what_to_do_now:
        "Phase 1 は raw config scan で確認し、Phase 2 で sandbox explain の解決挙動を調査してください。",
    });
  }

  return {
    effectiveHome: home,
    config: {
      path: params.configPath,
      readable: params.sourceConfigValid !== false,
      issues: params.configIssues ?? [],
    },
    sandbox: {
      mode: params.cfg.agents?.defaults?.sandbox?.mode ?? "default",
      scope: params.cfg.agents?.defaults?.sandbox?.scope ?? "default",
      workspaceAccess: params.cfg.agents?.defaults?.sandbox?.workspaceAccess ?? "default",
    },
    elevated: {
      enabled: params.cfg.tools?.elevated?.enabled !== false,
      wildcardAllowFrom,
    },
    approvals,
    wrappers,
    warnings,
  };
}

export function formatCoreHarnessSummary(summary: CoreHarnessSummary): string {
  const lines: string[] = [
    `Effective OpenClaw home: ${summary.effectiveHome.path} (source: ${summary.effectiveHome.source})`,
    `Config: ${summary.config.readable ? "readable" : "unreadable"} (${summary.config.path})`,
    `Sandbox: mode=${summary.sandbox.mode} scope=${summary.sandbox.scope} workspaceAccess=${summary.sandbox.workspaceAccess}`,
    `Elevated: enabled=${String(summary.elevated.enabled)} wildcardAllowFrom=${summary.elevated.wildcardAllowFrom.length}`,
    `Approvals: total=${summary.approvals.totalEntries} allowAlways=${summary.approvals.allowAlwaysEntries} opaqueCommand=${summary.approvals.opaqueCommandEntries}`,
    `Wrappers: openclaw-setup alias=${String(summary.wrappers.openclawSetupAlias)} homeResolver=${String(summary.wrappers.homeResolver)}`,
  ];
  if (summary.warnings.length === 0) {
    lines.push("Warnings: none");
    return lines.join("\n");
  }
  lines.push("Warnings:");
  for (const warning of summary.warnings) {
    lines.push(`- [${warning.severity}] ${warning.code}: ${warning.summary}`);
    lines.push(`  What to do now: ${warning.what_to_do_now}`);
  }
  return lines.join("\n");
}

export function noteCoreHarnessSummary(params: {
  cfg: OpenClawConfig;
  configPath: string;
  sourceConfigValid?: boolean;
  configIssues?: Array<{ path: string; message: string }>;
  env?: NodeJS.ProcessEnv;
  approvals?: ExecApprovalsFile;
}): CoreHarnessSummary {
  const summary = buildCoreHarnessSummary(params);
  note(formatCoreHarnessSummary(summary), "Core Harness Summary");
  return summary;
}
