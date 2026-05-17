import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovals, type ExecApprovalsFile } from "../infra/exec-approvals.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.types.js";
import { resolveEffectiveHomeDir, resolveOsHomeDir } from "../infra/home-dir.js";
import { note } from "../terminal/note.js";

const WRAPPER_LIB_RELATIVE_PATH = ".local/bin/oc-wrapper-lib";

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
    source: "env" | "home" | "userprofile" | "os-homedir" | "cwd";
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
  homedir: () => string = os.homedir,
): CoreHarnessSummary["effectiveHome"] {
  const envHome = normalizeNonEmptyString(env.OPENCLAW_HOME);
  const processHome = normalizeNonEmptyString(env.HOME);
  const userProfileHome = normalizeNonEmptyString(env.USERPROFILE);
  const osHome = (() => {
    try {
      return normalizeNonEmptyString(homedir());
    } catch {
      return null;
    }
  })();
  const source = envHome
    ? "env"
    : processHome
      ? "home"
      : userProfileHome
        ? "userprofile"
        : osHome
          ? "os-homedir"
          : "cwd";
  return {
    path: resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd()),
    source,
    processHome,
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
  wrapperPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
}): CoreHarnessSummary["wrappers"] {
  if (!params.existsSync(params.wrapperPath)) {
    return {
      openclawSetupAlias: false,
      homeResolver: false,
    };
  }
  const body = params.readFileSync(params.wrapperPath, "utf8");
  return {
    openclawSetupAlias: body.includes("openclaw-setup"),
    homeResolver: body.includes("resolve_openclaw_home") && body.includes("OPENCLAW_HOME"),
  };
}

export function resolveCoreHarnessJsonExitCode(params: {
  summary: Pick<CoreHarnessSummary, "warnings">;
  sourceConfigValid: boolean;
}): 0 | 1 | 2 | 3 {
  if (!params.sourceConfigValid) {
    return 2;
  }
  if (params.summary.warnings.some((warning) => warning.severity === "error")) {
    return 3;
  }
  if (params.summary.warnings.some((warning) => warning.severity === "warn")) {
    return 1;
  }
  return 0;
}

function addWarning(
  warnings: CoreHarnessWarning[],
  warning: Omit<CoreHarnessWarning, "safe_to_ignore_today"> & {
    safe_to_ignore_today?: boolean;
  },
): void {
  warnings.push({
    ...warning,
    safe_to_ignore_today: warning.safe_to_ignore_today ?? warning.severity === "info",
  });
}

export type CoreHarnessStartupIssues = {
  packageRootResolved: boolean;
  sourceInstallIssues: string[];
};

export function buildCoreHarnessSummary(params: {
  cfg: OpenClawConfig;
  configPath: string;
  sourceConfigValid?: boolean;
  configIssues?: Array<{ path: string; message: string }>;
  env?: NodeJS.ProcessEnv;
  approvals?: ExecApprovalsFile;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  wrapperPath?: string;
  startupIssues?: CoreHarnessStartupIssues;
}): CoreHarnessSummary {
  const env = params.env ?? process.env;
  const home = resolveCoreHarnessHome(env);
  const approvals = summarizeApprovals(params.approvals ?? loadExecApprovals());
  // Wrapper lives under the OS user home, not OPENCLAW_HOME (which may point
  // at a state-only directory like `~/.openclaw`). Fall back to the effective
  // home only when HOME / USERPROFILE / os.homedir() are all unavailable
  // (containerised or stripped environments), so we never lose detection.
  const wrapperBase = resolveOsHomeDir(env) ?? home.path;
  const wrapperPath = params.wrapperPath ?? path.join(wrapperBase, WRAPPER_LIB_RELATIVE_PATH);
  const existsSync = params.existsSync ?? fs.existsSync;
  const wrapperFileExists = existsSync(wrapperPath);
  const wrappers = inspectWrapperCoverage({
    wrapperPath,
    existsSync,
    readFileSync: params.readFileSync ?? fs.readFileSync,
  });
  const wildcardAllowFrom = collectAllowFromWildcards(params.cfg);
  const warnings: CoreHarnessWarning[] = [];

  if (params.startupIssues && !params.startupIssues.packageRootResolved) {
    addWarning(warnings, {
      code: "core-harness.startup.broken-shim",
      severity: "error",
      category: "new",
      summary: "OpenClaw package root could not be resolved from the running entrypoint.",
      what_to_do_now:
        "pnpm shim が壊れている可能性があります。`node $(pwd)/openclaw.mjs --version` で直接起動を確認し、必要なら `pnpm install -g .` をプロジェクトルートから再実行してください。",
    });
  }

  if (params.startupIssues && params.startupIssues.sourceInstallIssues.length > 0) {
    addWarning(warnings, {
      code: "core-harness.startup.broken-root",
      severity: "warn",
      category: "new",
      summary: "Source checkout install integrity issues detected during startup.",
      what_to_do_now: `\`pnpm install\` を再実行してください: ${params.startupIssues.sourceInstallIssues.join(" / ")}`,
    });
  }

  if (
    home.isolatedProcessHome &&
    path.resolve(home.processHome ?? os.homedir()) !== path.resolve(home.path)
  ) {
    // If OPENCLAW_HOME points at a non-isolated path the operator already
    // routed Core Harness away from the Codex sandbox, so the warning is
    // informational only. If OPENCLAW_HOME is unset, the resolver would have
    // fallen through to the isolated HOME (in which case effective home ==
    // process home and this branch is unreachable), but we still treat it as
    // error severity defensively. If OPENCLAW_HOME itself is isolated, the
    // operator did not escape the sandbox; keep error severity.
    const overrideIsIsolated = env.OPENCLAW_HOME == null || isIsolatedCodexHome(env.OPENCLAW_HOME);
    const severity: "error" | "warn" = overrideIsIsolated ? "error" : "warn";
    addWarning(warnings, {
      code: "core-harness.home.isolated",
      severity,
      category: "new",
      summary:
        severity === "error"
          ? "Core Harness is running from an isolated Codex-like HOME."
          : "Core Harness HOME is isolated, but OPENCLAW_HOME points at a non-isolated path.",
      what_to_do_now:
        severity === "error"
          ? "OPENCLAW_HOME を実運用 home に向けて、wrapper 経由で doctor を実行してください。"
          : "OPENCLAW_HOME が実 home を指していれば動作に支障はありません。HOME も合わせて実 home にすれば完全に解消されます。",
    });
  }

  if (!wrappers.openclawSetupAlias) {
    addWarning(warnings, {
      code: "core-harness.wrapper.openclaw-setup-alias-missing",
      severity: wrapperFileExists ? "warn" : "info",
      category: "new",
      summary: wrapperFileExists
        ? "wrapper repo aliases do not include active setup repo."
        : "wrapper file not detected; openclaw-setup alias coverage unverified.",
      what_to_do_now: wrapperFileExists
        ? "oc-wrapper-lib に openclaw-setup alias を追加してください。"
        : "oc-wrapper-lib が見つかりません。wrapper を使っている場合はパスと権限を確認してください。使っていなければこの警告は無視できます。",
    });
  }

  if (!wrappers.homeResolver) {
    addWarning(warnings, {
      code: "core-harness.wrapper.home-resolver-missing",
      severity: wrapperFileExists ? "warn" : "info",
      category: "new",
      summary: wrapperFileExists
        ? "wrapper home resolver is missing or not using OPENCLAW_HOME."
        : "wrapper file not detected; home-resolver coverage unverified.",
      what_to_do_now: wrapperFileExists
        ? "oc-wrapper-lib の HOME 解決を OPENCLAW_HOME 優先にしてください。"
        : "oc-wrapper-lib が見つかりません。wrapper を使っている場合はパスと権限を確認してください。使っていなければこの警告は無視できます。",
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
