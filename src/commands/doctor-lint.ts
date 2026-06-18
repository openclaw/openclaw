/** CLI entrypoint for structured doctor lint and explain health checks. */
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { readConfigFileSnapshot } from "../config/config.js";
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
import {
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  type HealthCheckContext,
  type HealthFinding,
} from "../flows/health-checks.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatDoctorExplainOutput } from "./doctor-explain.js";

interface DoctorLintCliOptions {
  readonly json?: boolean;
  readonly explain?: boolean;
  readonly severityMin?: string;
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly allowExec?: boolean;
}

type StructuredDoctorSetup =
  | {
      readonly kind: "invalid-config";
      readonly findings: readonly HealthFinding[];
    }
  | {
      readonly kind: "ready";
      readonly ctx: HealthCheckContext;
    };

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
    process.stdout.write(
      formatDoctorExplainOutput({
        checksRun: result.checksRun,
        findings: visible,
      }),
    );
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
  return { kind: "ready", ctx };
}
