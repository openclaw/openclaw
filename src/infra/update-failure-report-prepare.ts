/** Sanitizes and prepares one explicitly reviewed update-failure report. */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { valid as validSemver } from "semver";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { resolveStateDir } from "../config/paths.js";
import {
  redactPublicSupportDiagnosticLine,
  redactSupportString,
} from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";
import { prepareGithubIssue, type PreparedGithubIssue } from "./github-issue.js";
import { normalizeUpdateChannel } from "./update-channels.js";
import {
  formatUpdateFailureFact,
  selectUpdateFailureReportSteps,
} from "./update-failure-facts-format.js";
import { normalizeUpdateFailureFacts } from "./update-failure-facts.js";
import { projectPublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import type { UpdateRunResult, UpdateStepResult } from "./update-runner.js";

const UPDATE_REPORT_BODY_MAX_BYTES = 16_000;
const UPDATE_REPORT_FIELD_MAX_BYTES = 512;

export type PreparedUpdateFailureReport = PreparedGithubIssue & {
  attemptId: string;
  previewDigest: string;
  savedReportPath: string;
  url?: string;
};

export type UpdateFailureReportInput = {
  attemptId: string;
  error?: string;
  result: UpdateRunResult;
  recordedRun?: Pick<UpdateRunRecord, "runId" | "steps">;
  target?: string;
};

type UpdateFailureReportContext = {
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

function redactDiagnosticLines(value: string): string {
  // An unquoted final path component and trailing prose are grammatically
  // indistinguishable. Treat only the physical line containing a path as
  // private instead of guessing at a filename boundary.
  const privatePathLine =
    /\$OPENCLAW_STATE_DIR[\\/]|(?:^|[^\p{L}\p{N}._~-])(?:\/+|\\+|[A-Za-z]:[\\/]|~[\\/])/u;
  return value
    .split(/(\r\n|[\n\r\u2028\u2029])/u)
    .map((line) => {
      if (/^(?:\r\n|[\n\r\u2028\u2029])$/u.test(line)) {
        return line;
      }
      if (privatePathLine.test(line)) {
        return "[redacted-path]";
      }
      // Scalar codes/refs are useful evidence; arbitrary prose or shell syntax
      // can contain a command and private arguments from any executable.
      return /[\s"'`;$|&<>(){}[\]*?\\]/u.test(line.trim()) ? "[redacted-command]" : line;
    })
    .join("");
}

function sanitizeReportField(
  value: unknown,
  context: UpdateFailureReportContext,
  maxBytes = UPDATE_REPORT_FIELD_MAX_BYTES,
): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
      ? String(value)
      : "unknown";
  const redacted = redactSupportString(redactDiagnosticLines(text), {
    env: context.env,
    stateDir: context.stateDir,
  });
  return truncateUtf8Prefix(redacted.trim(), maxBytes);
}

function sanitizeFactIdentifier(value: string, context: UpdateFailureReportContext): string {
  if (REPORTABLE_RECORDED_PHASES.has(value)) {
    return value.replace(/\s+/gu, "-");
  }
  // DNS names are not check/reason/plugin identifiers. Numeric versions remain public facts.
  return isIP(value) ||
    (/^(?:[\p{L}\p{N}-]+\.)+[\p{L}][\p{L}\p{N}-]*(?::\d+)?$/u.test(value) && !validSemver(value))
    ? "[redacted-host]"
    : sanitizeReportField(value, context);
}

function sanitizeFactConfigKey(value: string): string {
  // Validation paths can contain operator-defined record keys at any depth.
  const anchor =
    /^(mcp\.servers|models\.providers|plugins\.entries|skills\.entries|auth\.profiles|cron\.jobs|agents\.list|hooks\.internal\.entries|engines\.node)(?:\.|$)/u.exec(
      value,
    )?.[1] ??
    /^(agents|auth|channels|commands|cron|engines|gateway|hooks|mcp|messages|models|plugins|session|skills|stateDir|tools)(?:\.|$)/u.exec(
      value,
    )?.[1];
  return anchor ? (value === anchor ? anchor : `${anchor}.*`) : "[redacted-key]";
}

const REPORTABLE_RECORDED_PHASES = new Set<string>([
  ...UPDATE_RUN_PHASES,
  "package rollback",
  "global install verify",
  "global install swap",
  "npm lifecycle policy preflight",
]);
type ReportedFailedStep = Pick<
  UpdateStepResult,
  "name" | "exitCode" | "termination" | "failureFacts"
>;

function resolveFailedSteps(input: UpdateFailureReportInput): ReportedFailedStep[] {
  const direct = new Map(input.result.steps.map((step) => [step.name, step]));
  const recorded = input.recordedRun?.runId === input.attemptId ? input.recordedRun.steps : [];
  const recordedNames = new Set(recorded.map((step) => step.step));
  const failed = (step: UpdateStepResult) =>
    !step.advisory &&
    (step.exitCode !== 0 || step.killed === true || step.termination === "timeout");
  // The ledger orders recovery after the initial failure; measured results enrich it in place.
  return [
    ...Array.from(direct.values()).filter((step) => failed(step) && !recordedNames.has(step.name)),
    ...recorded.flatMap((step): ReportedFailedStep[] => {
      const measured = direct.get(step.step);
      if (measured) {
        return failed(measured)
          ? [{ ...measured, failureFacts: measured.failureFacts ?? step.failureFacts }]
          : [];
      }
      return step.status === "failed"
        ? [
            {
              name: step.step,
              exitCode: null,
              failureFacts: step.failureFacts,
            },
          ]
        : [];
    }),
  ];
}

function resolveFailedPhase(
  result: UpdateRunResult,
  steps: ReportedFailedStep[],
  context: UpdateFailureReportContext,
): string {
  const failed = steps.at(-1);
  const phase = sanitizeFactIdentifier(failed?.name ?? result.reason ?? "unknown", context);
  // Some updater labels are executable text (for example, the Doctor step).
  // Keep the structured failure code visible without publishing that command.
  return phase === "[redacted-command]" || phase === "[redacted-path]"
    ? sanitizeReportField(result.reason ?? "unknown", context)
    : phase;
}

function resolveUpdateTarget(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string {
  const explicit = input.target?.trim();
  if (explicit) {
    // update.run records these two display forms from validated campaign facts.
    // Revalidate their scalar payloads before adding the fixed display words.
    const version = explicit.startsWith("version ") ? explicit.slice("version ".length) : null;
    if (version && !/\s/u.test(version) && validSemver(version)) {
      return `version ${sanitizeReportField(version, context)}`;
    }
    const channel = explicit.endsWith(" channel")
      ? normalizeUpdateChannel(explicit.slice(0, -" channel".length))
      : null;
    if (channel) {
      return `${channel} channel`;
    }
    return sanitizeReportField(explicit, context);
  }
  return truncateUtf8Prefix(
    `exact target unavailable; mode: ${sanitizeReportField(input.result.mode, context)}`,
    UPDATE_REPORT_FIELD_MAX_BYTES,
  );
}

function resolveRecoveryOutcome(
  result: UpdateRunResult,
  context: UpdateFailureReportContext,
): string {
  if (result.recovery?.serviceRestartSafe === true) {
    if (result.recovery.service === "failed") {
      return "runtime files verified; Gateway restart failed. Run `openclaw gateway status --deep` before restarting manually.";
    }
    return "verified safe to restart";
  }
  if (result.recovery?.serviceRestartSafe === false) {
    const outcome =
      result.recovery.packageRollbackVerified === true
        ? "package rollback verified; service restart not verified"
        : "not verified";
    return truncateUtf8Prefix(
      `${outcome} (${sanitizeReportField(result.recovery.reason, context)})`,
      UPDATE_REPORT_FIELD_MAX_BYTES,
    );
  }
  return "not recorded";
}

async function renderBoundedDiagnostics(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
  steps: ReportedFailedStep[],
): Promise<string[]> {
  const diagnostics = [
    `Result: ${input.result.status}`,
    `Update mode: ${sanitizeReportField(input.result.mode, context)}`,
    `Reason code: ${sanitizeReportField(input.result.reason ?? "unknown", context)}`,
  ];
  if (input.result.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON) {
    diagnostics.push(`Advisory: ${LEGACY_UPDATE_RUN_ADVISORY}`);
  }
  // Reviewed identity facts also bind consent when the run ID stays the same.
  for (const [label, identity] of [
    ["Before", input.result.before],
    ["After", input.result.after],
  ] as const) {
    for (const field of ["version", "sha"] as const) {
      if (identity?.[field]) {
        diagnostics.push(`${label} ${field}: ${sanitizeReportField(identity[field], context)}`);
      }
    }
  }
  if (input.result.after?.buildId) {
    diagnostics.push(`After build: ${sanitizeReportField(input.result.after.buildId, context)}`);
  }
  for (const step of selectUpdateFailureReportSteps(steps)) {
    const phase = sanitizeFactIdentifier(step.name, context);
    const termination = step.termination ? `, termination ${step.termination}` : "";
    diagnostics.push(`Failed phase ${phase}: exit ${step.exitCode ?? "unknown"}${termination}`);
    diagnostics.push(
      ...(await Promise.all(
        normalizeUpdateFailureFacts(step.failureFacts ?? [], context.env).map(async (fact) =>
          formatUpdateFailureFact({
            ...(await projectPublicUpdateFailureIdentifiers(fact)),
            ...(fact.affectedKey ? { affectedKey: sanitizeFactConfigKey(fact.affectedKey) } : {}),
            ...(fact.message
              ? { message: redactPublicSupportDiagnosticLine(fact.message, context) }
              : {}),
          }),
        ),
      )),
    );
  }
  return diagnostics;
}

function resolveReportPaths(
  attemptId: string,
  stateDir: string,
): {
  reportDir: string;
  reportPath: string;
} {
  const key = createHash("sha256").update(attemptId).digest("hex");
  const reportDir = path.join(stateDir, "update-reports");
  return {
    reportDir,
    reportPath: path.join(reportDir, `${key}.md`),
  };
}

/** Builds the exact sanitized body the user must review before submission. */
export async function prepareUpdateFailureReport(
  input: UpdateFailureReportInput,
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): Promise<PreparedUpdateFailureReport> {
  if (!input.attemptId.trim()) {
    throw new Error("Update report attempt identity is required.");
  }
  if (classifyUpdateOutcome(input.result) !== "failed") {
    throw new Error("Only a final failed update can be reported.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const version = sanitizeReportField(VERSION, context);
  const platform = sanitizeReportField(`${process.platform}/${process.arch}`, context);
  const target = resolveUpdateTarget(input, context);
  const steps = resolveFailedSteps(input);
  const phase = resolveFailedPhase(input.result, steps, context);
  const recovery = resolveRecoveryOutcome(input.result, context);
  const bodyWithoutMarker = [
    "# OpenClaw update failure report",
    "",
    "This report was explicitly reviewed and confirmed in OpenClaw.",
    "",
    `- OpenClaw version: ${version}`,
    `- Platform: ${platform}`,
    `- Node version: ${sanitizeReportField(process.versions.node ?? "unknown", context)}`,
    `- Update target: ${target}`,
    `- Failed phase: ${phase}`,
    `- Recovery outcome: ${recovery}`,
    "",
    "## Bounded diagnostics",
    "",
    ...(await renderBoundedDiagnostics(input, context, steps)).map((line) => `- ${line}`),
    "",
  ].join("\n");
  const reconciliationMarker = `openclaw-update-report:${createHash("sha256")
    .update(`${input.attemptId}\0${bodyWithoutMarker}`)
    .digest("hex")}`;
  const body = truncateUtf8Prefix(
    bodyWithoutMarker.replace(
      "This report was explicitly reviewed and confirmed in OpenClaw.\n",
      `This report was explicitly reviewed and confirmed in OpenClaw.\n\n<!-- ${reconciliationMarker} -->\n`,
    ),
    UPDATE_REPORT_BODY_MAX_BYTES,
  );
  const title = truncateUtf8Prefix(`Update failure: ${phase} (${version})`, 200).replace(
    /\s+/gu,
    " ",
  );
  const issue = prepareGithubIssue({ title, body });
  const { reportPath } = resolveReportPaths(input.attemptId, stateDir);
  return {
    ...issue,
    attemptId: input.attemptId,
    previewDigest: createHash("sha256").update(issue.body).digest("hex"),
    savedReportPath: reportPath,
    ...(issue.browserFallback.status === "available" ? { url: issue.browserFallback.url } : {}),
  };
}
