/** CLI entrypoint for structured doctor lint, explain, and focused repair health checks. */
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerBundledHealthChecks } from "../flows/bundled-health-checks.js";
import {
  configValidationIssuesToHealthFindings,
  registerCoreHealthChecks,
} from "../flows/doctor-core-checks.js";
import {
  exitCodeFromFindings,
  runDoctorLintChecks,
  type DoctorLintRunOptions,
} from "../flows/doctor-lint-flow.js";
import { runDoctorHealthRepairs } from "../flows/doctor-repair-flow.js";
import { listHealthChecks } from "../flows/health-check-registry.js";
import {
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "../flows/health-checks.js";
import type { RuntimeEnv } from "../runtime.js";
import { explainRepairPromptLabel, formatDoctorExplainOutput } from "./doctor-explain.js";
import { applyWizardMetadata } from "./onboard-helpers.js";

interface DoctorLintCliOptions {
  readonly json?: boolean;
  readonly explain?: boolean;
  readonly severityMin?: string;
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly allowExec?: boolean;
  readonly nonInteractive?: boolean;
  readonly confirmRepairCheck?: (params: {
    readonly checkId: string;
    readonly label: string;
    readonly findings: readonly HealthFinding[];
  }) => Promise<boolean>;
}

interface DoctorSelectedRepairCliOptions {
  readonly onlyIds: readonly string[];
  readonly allowExec?: boolean;
}

type StructuredDoctorSetup =
  | {
      readonly kind: "invalid-config";
      readonly findings: readonly HealthFinding[];
      readonly checks: readonly HealthCheck[];
    }
  | {
      readonly kind: "ready";
      readonly ctx: HealthCheckContext;
      readonly checks: readonly HealthCheck[];
    };

type ReadyStructuredDoctorSetup = Extract<StructuredDoctorSetup, { readonly kind: "ready" }>;

function detectMode(opts: DoctorLintCliOptions): "human" | "json" | "explain" {
  if (opts.explain === true) {
    return "explain";
  }
  if (opts.json === true) {
    return "json";
  }
  return process.stdout.isTTY ? "human" : "json";
}

/**
 * Runs registered doctor health checks in human or JSON mode and returns the lint exit code.
 *
 * Invalid config is reported before regular health checks because most checks need a parsed config
 * and workspace root.
 */
export async function runDoctorLintCli(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
): Promise<number> {
  const sevMin =
    opts.severityMin === undefined ? "info" : parseHealthFindingSeverity(opts.severityMin);
  if (sevMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  const mode = detectMode(opts);
  if (mode === "explain" && opts.json === true) {
    throw new Error("doctor --explain cannot be combined with --json.");
  }

  const setup = await prepareStructuredDoctorSetup(runtime, opts.allowExec === true);
  if (setup.kind === "invalid-config") {
    const visible = setup.findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
    if (mode === "json") {
      writeJsonResult({
        ok: false,
        checksRun: 1,
        checksSkipped: 0,
        findings: visible,
      });
    } else if (mode === "explain") {
      process.stdout.write(
        formatDoctorExplainOutput({
          checksRun: 1,
          findings: visible,
          repairableCheckIds: new Set(),
        }),
      );
    } else {
      runtime.error("doctor --lint: config file exists but does not parse cleanly.");
      for (const finding of visible) {
        const path = finding.path || "<root>";
        runtime.error(`- ${path}: ${finding.message}`);
      }
    }
    return exitCodeFromFindings(setup.findings, sevMin);
  }

  const runOpts: DoctorLintRunOptions = {
    ...(opts.skipIds && opts.skipIds.length > 0 ? { skipIds: opts.skipIds } : {}),
    ...(opts.onlyIds && opts.onlyIds.length > 0 ? { onlyIds: opts.onlyIds } : {}),
  };
  const result = await runDoctorLintChecks(setup.ctx, runOpts);
  const visible = result.findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));

  if (mode === "json") {
    writeJsonResult({
      ok: exitCodeFromFindings(result.findings, sevMin) === 0,
      checksRun: result.checksRun,
      checksSkipped: result.checksSkipped,
      findings: visible,
    });
  } else if (mode === "explain") {
    const repairableCheckIds = collectFocusedRepairCheckIds(setup.checks);
    process.stdout.write(
      formatDoctorExplainOutput({
        checksRun: result.checksRun,
        findings: visible,
        repairableCheckIds,
      }),
    );
    await maybePromptForExplainRepairs(runtime, setup, visible, repairableCheckIds, opts);
  } else {
    process.stdout.write(
      `doctor --lint: ran ${result.checksRun} check(s), ${visible.length} finding(s)\n`,
    );
    if (visible.length === 0) {
      process.stdout.write("  no findings\n");
    } else {
      for (const f of visible) {
        const where = f.path !== undefined ? ` ${f.path}` : "";
        const line = f.line !== undefined ? `:${f.line}` : "";
        process.stdout.write(`  [${f.severity}] ${f.checkId}${where}${line} - ${f.message}\n`);
        if (f.fixHint !== undefined) {
          process.stdout.write(`    fix: ${f.fixHint}\n`);
        }
      }
    }
  }

  return exitCodeFromFindings(result.findings, sevMin);
}

export async function runDoctorSelectedRepairCli(
  runtime: RuntimeEnv,
  opts: DoctorSelectedRepairCliOptions,
): Promise<number> {
  if (opts.onlyIds.length === 0) {
    throw new Error("doctor --fix --only requires at least one health check id.");
  }
  const setup = await prepareStructuredDoctorSetup(runtime, opts.allowExec === true);
  if (setup.kind === "invalid-config") {
    runtime.error("doctor --fix --only: config file exists but does not parse cleanly.");
    for (const finding of setup.findings) {
      const path = finding.path || "<root>";
      runtime.error(`- ${path}: ${finding.message}`);
    }
    return 1;
  }

  const result = await runSelectedDoctorRepair(runtime, setup, opts);
  return result.exitCode;
}

async function runSelectedDoctorRepair(
  runtime: RuntimeEnv,
  setup: ReadyStructuredDoctorSetup,
  opts: DoctorSelectedRepairCliOptions,
): Promise<{ exitCode: number; config: OpenClawConfig }> {
  const selected = selectHealthChecks(setup.checks, opts.onlyIds);
  if (selected.unknownIds.length > 0) {
    for (const id of selected.unknownIds) {
      runtime.error(`Unknown health check id selected by --only: ${id}.`);
    }
    return { exitCode: 1, config: setup.ctx.cfg };
  }
  const repairableCheckIds = collectFocusedRepairCheckIds(selected.checks);
  const nonRepairable = selected.checks.filter((check) => !repairableCheckIds.has(check.id));
  if (nonRepairable.length > 0) {
    for (const check of nonRepairable) {
      runtime.error(`Health check ${check.id} does not support automatic repair.`);
    }
    return { exitCode: 1, config: setup.ctx.cfg };
  }

  const result = await runDoctorHealthRepairs(
    {
      mode: "fix",
      runtime,
      cfg: setup.ctx.cfg,
      cwd: setup.ctx.cwd,
      configPath: setup.ctx.configPath,
      allowExecSecretRefs: opts.allowExec === true,
    },
    { checks: selected.checks },
  );
  if (result.changes.length > 0) {
    process.stdout.write(`doctor --fix --only: ${result.changes.length} change(s)\n`);
    for (const change of result.changes) {
      process.stdout.write(`  - ${change}\n`);
    }
  } else {
    process.stdout.write("doctor --fix --only: no changes\n");
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      runtime.error(`warning: ${warning}`);
    }
    runtime.error("doctor --fix --only: selected check reported warning(s).");
    return { exitCode: 1, config: setup.ctx.cfg };
  }
  if (result.checksRepaired === 0 && result.findings.length > 0) {
    runtime.error("doctor --fix --only: selected check did not apply a repair.");
    return { exitCode: 1, config: setup.ctx.cfg };
  }
  let persistedConfig = setup.ctx.cfg;
  if (JSON.stringify(result.config) !== JSON.stringify(setup.ctx.cfg)) {
    const nextConfig = applyWizardMetadata(result.config, {
      command: "doctor",
      mode: result.config.gateway?.mode === "remote" ? "remote" : "local",
    });
    await replaceConfigFile({
      nextConfig,
      afterWrite: { mode: "auto" },
      writeOptions: {},
    });
    logConfigUpdated(runtime);
    persistedConfig = nextConfig;
  }
  if (result.remainingFindings.length > 0) {
    runtime.error(
      `doctor --fix --only: ${result.remainingFindings.length} finding(s) remain after repair.`,
    );
    return { exitCode: 1, config: persistedConfig };
  }
  return { exitCode: 0, config: persistedConfig };
}

function writeJsonResult(result: {
  ok: boolean;
  checksRun: number;
  checksSkipped: number;
  findings: readonly HealthFinding[];
}): void {
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      checksRun: result.checksRun,
      checksSkipped: result.checksSkipped,
      findings: result.findings.map(toJsonFinding),
    }) + "\n",
  );
}

function toJsonFinding(f: HealthFinding): Record<string, unknown> {
  return {
    checkId: f.checkId,
    severity: f.severity,
    message: f.message,
    ...(f.source !== undefined ? { source: f.source } : {}),
    ...(f.path !== undefined ? { path: f.path } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.column !== undefined ? { column: f.column } : {}),
    ...(f.ocPath !== undefined ? { ocPath: f.ocPath } : {}),
    ...(f.target !== undefined ? { target: f.target } : {}),
    ...(f.requirement !== undefined ? { requirement: f.requirement } : {}),
    ...(f.fixHint !== undefined ? { fixHint: f.fixHint } : {}),
  };
}

async function prepareStructuredDoctorSetup(
  runtime: RuntimeEnv,
  allowExec: boolean,
): Promise<StructuredDoctorSetup> {
  registerCoreHealthChecks();
  const snapshot = await readConfigFileSnapshot({ observe: false });
  if (snapshot.exists && !snapshot.valid) {
    return {
      kind: "invalid-config",
      findings: configValidationIssuesToHealthFindings(snapshot.issues),
      checks: listHealthChecks(),
    };
  }

  const cwd = resolveAgentWorkspaceDir(snapshot.config, resolveDefaultAgentId(snapshot.config));
  const ctx: HealthCheckContext = {
    mode: "lint",
    runtime,
    cfg: snapshot.config,
    cwd,
    allowExecSecretRefs: allowExec,
    ...(snapshot.path !== undefined ? { configPath: snapshot.path } : {}),
  };
  registerBundledHealthChecks({ cfg: snapshot.config, cwd });
  return { kind: "ready", ctx, checks: listHealthChecks() };
}

function collectFocusedRepairCheckIds(checks: readonly HealthCheck[]): ReadonlySet<string> {
  return new Set(
    checks
      .filter((check) => check.focusedRepair === true && check.repair !== undefined)
      .map((check) => check.id),
  );
}

function selectHealthChecks(
  checks: readonly HealthCheck[],
  onlyIds: readonly string[],
): { checks: readonly HealthCheck[]; unknownIds: readonly string[] } {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const selected: HealthCheck[] = [];
  const unknownIds: string[] = [];
  for (const id of onlyIds) {
    const check = byId.get(id);
    if (check === undefined) {
      unknownIds.push(id);
    } else {
      selected.push(check);
    }
  }
  return { checks: selected, unknownIds };
}

async function maybePromptForExplainRepairs(
  runtime: RuntimeEnv,
  setup: ReadyStructuredDoctorSetup,
  findings: readonly HealthFinding[],
  repairableCheckIds: ReadonlySet<string>,
  opts: DoctorLintCliOptions,
): Promise<void> {
  if (opts.nonInteractive === true || findings.length === 0) {
    return;
  }
  if (opts.confirmRepairCheck === undefined) {
    return;
  }
  const repairableGroups = [...new Set(findings.map((finding) => finding.checkId))].filter((id) =>
    repairableCheckIds.has(id),
  );
  let repairSetup = setup;
  for (const checkId of repairableGroups) {
    const groupFindings = findings.filter((finding) => finding.checkId === checkId);
    const label = explainRepairPromptLabel(checkId);
    const confirmed = await opts.confirmRepairCheck({ checkId, label, findings: groupFindings });
    if (!confirmed) {
      continue;
    }
    const result = await runSelectedDoctorRepair(runtime, repairSetup, {
      onlyIds: [checkId],
      allowExec: opts.allowExec,
    });
    repairSetup = updateReadyDoctorSetupConfig(repairSetup, result.config);
  }
}

function updateReadyDoctorSetupConfig(
  setup: ReadyStructuredDoctorSetup,
  cfg: OpenClawConfig,
): ReadyStructuredDoctorSetup {
  return {
    ...setup,
    ctx: {
      ...setup.ctx,
      cfg,
    },
  };
}
