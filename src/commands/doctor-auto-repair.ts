/**
 * Doctor Auto-Repair — automated diagnostic checks and repairs for common
 * issues that can be resolved without user interaction.
 *
 * Each repair is expressed as a `RepairRule` — a small, self-contained check
 * that returns an optional `RepairAction`.  All rules are run in sequence and
 * the results are collected into a typed report.
 *
 * Design goals:
 *   - Zero user prompts in non-interactive mode
 *   - Safe by default: never deletes user data, only fixes structure/permissions
 *   - Idempotent: running twice produces the same result
 *   - Composable: new rules are added by pushing to `BUILTIN_RULES`
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepairSeverity = "critical" | "warning" | "info";

export type RepairAction = {
  ruleId: string;
  severity: RepairSeverity;
  description: string;
  repaired: boolean;
  detail?: string;
};

export type RepairReport = {
  actions: RepairAction[];
  passed: number;
  repaired: number;
  failed: number;
  skipped: number;
  durationMs: number;
};

export type RepairContext = {
  stateDir: string;
  dryRun: boolean;
};

export type RepairRule = {
  id: string;
  description: string;
  severity: RepairSeverity;
  check: (ctx: RepairContext) => RepairAction | undefined;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function canWrite(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isValidJson(filePath: string): boolean {
  try {
    JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Builtin rules
// ---------------------------------------------------------------------------

const stateDirRule: RepairRule = {
  id: "state-dir-exists",
  description: "State directory exists and is writable",
  severity: "critical",
  check(ctx) {
    if (existsDir(ctx.stateDir) && canWrite(ctx.stateDir)) {
      return undefined; // OK
    }
    if (ctx.dryRun) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: `State directory missing or not writable: ${ctx.stateDir}`,
        repaired: false,
        detail: "Would create state directory",
      };
    }
    const ok = ensureDir(ctx.stateDir);
    return {
      ruleId: this.id,
      severity: this.severity,
      description: `State directory missing: ${ctx.stateDir}`,
      repaired: ok,
      detail: ok ? "Created state directory" : "Failed to create state directory",
    };
  },
};

const statePermissionsRule: RepairRule = {
  id: "state-dir-permissions",
  description: "State directory has secure permissions (700)",
  severity: "warning",
  check(ctx) {
    if (process.platform === "win32") {
      return undefined;
    }
    if (!existsDir(ctx.stateDir)) {
      return undefined; // Handled by state-dir-exists
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(ctx.stateDir);
    } catch {
      return undefined;
    }
    const perms = stat.mode & 0o777;
    if ((perms & 0o077) === 0) {
      return undefined; // OK
    }
    if (ctx.dryRun) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: `State directory permissions too open (0${perms.toString(8)})`,
        repaired: false,
        detail: "Would set permissions to 700",
      };
    }
    try {
      fs.chmodSync(ctx.stateDir, 0o700);
      return {
        ruleId: this.id,
        severity: this.severity,
        description: `State directory permissions too open (0${perms.toString(8)})`,
        repaired: true,
        detail: "Set permissions to 700",
      };
    } catch (err) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: `State directory permissions too open (0${perms.toString(8)})`,
        repaired: false,
        detail: `chmod failed: ${String(err)}`,
      };
    }
  },
};

const sessionsDirRule: RepairRule = {
  id: "sessions-dir-exists",
  description: "Sessions directory exists",
  severity: "warning",
  check(ctx) {
    const sessionsDir = path.join(ctx.stateDir, "sessions");
    if (existsDir(sessionsDir)) {
      return undefined;
    }
    if (ctx.dryRun) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: "Sessions directory missing",
        repaired: false,
        detail: "Would create sessions directory",
      };
    }
    const ok = ensureDir(sessionsDir);
    return {
      ruleId: this.id,
      severity: this.severity,
      description: "Sessions directory missing",
      repaired: ok,
      detail: ok ? "Created sessions directory" : "Failed to create",
    };
  },
};

const lockFileStalenessRule: RepairRule = {
  id: "stale-lock-files",
  description: "No stale lock files in state directory",
  severity: "info",
  check(ctx) {
    if (!existsDir(ctx.stateDir)) {
      return undefined;
    }
    const MAX_LOCK_AGE_MS = 30 * 60 * 1000; // 30 minutes
    let entries: string[];
    try {
      entries = fs.readdirSync(ctx.stateDir);
    } catch {
      return undefined;
    }
    const staleLocks: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".lock")) {
        continue;
      }
      const lockPath = path.join(ctx.stateDir, entry);
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > MAX_LOCK_AGE_MS) {
          staleLocks.push(entry);
        }
      } catch {
        // skip
      }
    }
    if (staleLocks.length === 0) {
      return undefined;
    }
    if (ctx.dryRun) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: `${staleLocks.length} stale lock file(s) found`,
        repaired: false,
        detail: `Would remove: ${staleLocks.join(", ")}`,
      };
    }
    let removedCount = 0;
    for (const lock of staleLocks) {
      try {
        fs.unlinkSync(path.join(ctx.stateDir, lock));
        removedCount += 1;
      } catch {
        // skip
      }
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      description: `${staleLocks.length} stale lock file(s) found`,
      repaired: removedCount === staleLocks.length,
      detail: `Removed ${removedCount}/${staleLocks.length} stale locks`,
    };
  },
};

const corruptedJsonRule: RepairRule = {
  id: "corrupted-json-config",
  description: "JSON config files are parseable",
  severity: "critical",
  check(ctx) {
    const configDir = ctx.stateDir;
    if (!existsDir(configDir)) {
      return undefined;
    }
    const jsonFiles = ["openclaw.json", "session-store.json"];
    const corrupted: string[] = [];

    for (const fileName of jsonFiles) {
      const filePath = path.join(configDir, fileName);
      if (existsFile(filePath) && !isValidJson(filePath)) {
        corrupted.push(fileName);
      }
    }

    if (corrupted.length === 0) {
      return undefined;
    }

    if (ctx.dryRun) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: `${corrupted.length} corrupted JSON file(s)`,
        repaired: false,
        detail: `Corrupted: ${corrupted.join(", ")}. Would create .bak backup and reset.`,
      };
    }

    let repairedCount = 0;
    for (const fileName of corrupted) {
      const filePath = path.join(configDir, fileName);
      try {
        const backupPath = filePath + `.bak.${Date.now()}`;
        fs.copyFileSync(filePath, backupPath);
        fs.writeFileSync(filePath, "{}");
        repairedCount += 1;
      } catch {
        // skip
      }
    }

    return {
      ruleId: this.id,
      severity: this.severity,
      description: `${corrupted.length} corrupted JSON file(s)`,
      repaired: repairedCount === corrupted.length,
      detail: `Backed up and reset ${repairedCount}/${corrupted.length} files`,
    };
  },
};

const logDirRule: RepairRule = {
  id: "log-dir-exists",
  description: "Log directory exists",
  severity: "info",
  check(ctx) {
    const logDir = path.join(ctx.stateDir, "logs");
    if (existsDir(logDir)) {
      return undefined;
    }
    if (ctx.dryRun) {
      return {
        ruleId: this.id,
        severity: this.severity,
        description: "Log directory missing",
        repaired: false,
        detail: "Would create log directory",
      };
    }
    const ok = ensureDir(logDir);
    return {
      ruleId: this.id,
      severity: this.severity,
      description: "Log directory missing",
      repaired: ok,
      detail: ok ? "Created log directory" : "Failed to create",
    };
  },
};

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

export const BUILTIN_RULES: readonly RepairRule[] = [
  stateDirRule,
  statePermissionsRule,
  sessionsDirRule,
  logDirRule,
  lockFileStalenessRule,
  corruptedJsonRule,
] as const;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runAutoRepair(
  ctx: RepairContext,
  rules: readonly RepairRule[] = BUILTIN_RULES,
): RepairReport {
  const start = Date.now();
  const actions: RepairAction[] = [];
  let passed = 0;
  let repaired = 0;
  let failed = 0;
  let skipped = 0;

  for (const rule of rules) {
    try {
      const result = rule.check(ctx);
      if (!result) {
        passed += 1;
      } else if (result.repaired) {
        repaired += 1;
        actions.push(result);
      } else if (ctx.dryRun) {
        skipped += 1;
        actions.push(result);
      } else {
        failed += 1;
        actions.push(result);
      }
    } catch {
      failed += 1;
      actions.push({
        ruleId: rule.id,
        severity: rule.severity,
        description: `Rule "${rule.id}" threw an exception`,
        repaired: false,
      });
    }
  }

  return {
    actions,
    passed,
    repaired,
    failed,
    skipped,
    durationMs: Date.now() - start,
  };
}

/**
 * Format a repair report as a human-readable string.
 */
export function formatRepairReport(report: RepairReport): string {
  const lines: string[] = [];
  lines.push(`Doctor Auto-Repair (${report.durationMs}ms)`);
  lines.push(`  Passed: ${report.passed}  Repaired: ${report.repaired}  Failed: ${report.failed}  Skipped: ${report.skipped}`);
  for (const action of report.actions) {
    const icon = action.repaired ? "\u2714" : "\u2718";
    const severity = action.severity.toUpperCase().padEnd(8);
    lines.push(`  ${icon} [${severity}] ${action.description}`);
    if (action.detail) {
      lines.push(`    ${action.detail}`);
    }
  }
  return lines.join("\n");
}
