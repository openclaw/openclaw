/** Sanitizes and prepares one explicitly reviewed update-failure report. */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { valid as validSemver } from "semver";
import { resolveStateDir } from "../config/paths.js";
import {
  redactPublicSupportDiagnosticLine,
  redactPublicSupportVersion,
  redactSupportDiagnosticLine,
  redactSupportString,
} from "../logging/diagnostic-support-redaction.js";
import {
  classifyUpdateOutcome,
  UPDATE_FOREIGN_DESTINATION_REASON,
} from "../shared/update-outcome.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";
import { prepareGithubIssue, type PreparedGithubIssue } from "./github-issue.js";
import { normalizeUpdateChannel } from "./update-channels.js";
import { UPDATE_DESTINATION_RECOVERY } from "./update-destination-failure.js";
import { normalizeUpdateDoctorLintFindings } from "./update-doctor-lint.js";
import {
  formatUpdateFailureFact,
  selectUpdateFailureReportSteps,
} from "./update-failure-facts-format.js";
import { normalizeUpdateFailureFacts } from "./update-failure-facts.js";
import {
  isPublicUpdateFailureCode,
  projectPublicUpdateFailureIdentifiers,
} from "./update-failure-public-identifiers.js";
import { formatNpmFailureFacts } from "./update-npm-failure.js";
import { updatePreflightDetailMessage } from "./update-preflight-details.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { readUpdateRunReportHealth } from "./update-run-report-health.js";
import {
  formatUpdateRunRecovery,
  formatUpdateRunCurrentHealth,
  formatUpdateRunIdentity,
  updateRunReportInputFromResult,
} from "./update-run-report.js";
import { updateRunStepKey } from "./update-run-step-key.js";
import { isFailedUpdateStep, updateRunWarningMessages } from "./update-run-step.js";
import type { UpdateRunResult, UpdateStepResult } from "./update-runner-types.js";
import { resolvePublicUpdateStepId } from "./update-step-identity.js";

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
  action?: "cli";
  recordedRun?: Pick<UpdateRunRecord, "runId" | "steps"> &
    Partial<Pick<UpdateRunRecord, "trigger" | "reason" | "target" | "after" | "verification">>;
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
  const stepId = resolvePublicUpdateStepId(value);
  if (stepId) {
    return stepId;
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

type ReportedFailedStep = Pick<
  UpdateStepResult,
  "name" | "exitCode" | "termination" | "failureFacts" | "stderrTail"
> & { detail?: string };

function resolveFailedSteps(input: UpdateFailureReportInput): ReportedFailedStep[] {
  const direct = new Map(input.result.steps.map((step) => [updateRunStepKey(step.name), step]));
  const recorded = input.recordedRun?.runId === input.attemptId ? input.recordedRun.steps : [];
  const recordedNames = new Set(recorded.map((step) => updateRunStepKey(step.step)));
  // The ledger orders recovery after the initial failure; measured results enrich it in place.
  return [
    ...Array.from(direct.values()).filter(
      (step) => isFailedUpdateStep(step) && !recordedNames.has(updateRunStepKey(step.name)),
    ),
    ...recorded.flatMap((step): ReportedFailedStep[] => {
      const measured = direct.get(updateRunStepKey(step.step));
      if (measured) {
        return isFailedUpdateStep(measured)
          ? [{ ...measured, failureFacts: measured.failureFacts ?? step.failureFacts }]
          : [];
      }
      return step.status === "failed"
        ? [
            {
              name: step.step,
              exitCode: step.exitCode ?? null,
              failureFacts: step.failureFacts,
              detail: step.detail,
            },
          ]
        : [];
    }),
  ];
}

function resolveUpdateTarget(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string {
  const explicit =
    input.target?.trim() ||
    input.recordedRun?.target?.sha ||
    input.recordedRun?.target?.version ||
    input.recordedRun?.target?.tag ||
    input.recordedRun?.target?.channel;
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
    `exact target unavailable; mode: ${sanitizeReportField(resolveUpdateMode(input), context)}`,
    UPDATE_REPORT_FIELD_MAX_BYTES,
  );
}

function resolveUpdateMode(input: UpdateFailureReportInput): string {
  return input.result.mode === "unknown"
    ? (input.recordedRun?.target?.kind ?? "unknown")
    : input.result.mode;
}

function resolveRecoveryOutcome(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string {
  const { verification, steps } = updateRunReportInputFromResult(input.result, input.recordedRun);
  const recovery = verification.recovery;
  const observation = steps.findLast((step) => step.step === "gateway recovery verification");
  return (
    formatUpdateRunRecovery(
      {
        ...verification,
        recovery: recovery?.serviceRestartSafe
          ? { ...recovery, version: redactPublicSupportVersion(recovery.version) }
          : recovery,
        runningVersion: verification.runningVersion
          ? redactPublicSupportVersion(verification.runningVersion)
          : undefined,
      },
      observation && {
        exitCode: observation.exitCode,
        failureFacts: observation.failureFacts?.map((fact) => ({
          check: fact.check,
          code: isPublicUpdateFailureCode(fact.code) ? fact.code : "gateway-probe-failed",
        })),
      },
      sanitizeReportField(recovery?.reason ?? "not-recorded", context, 96),
    ) ??
    (steps.some(
      (step) => step.step === "finalize:package-rollback-not-needed" && step.status === "skipped",
    )
      ? "package rollback not needed: no package mutation"
      : "not recorded")
  );
}

async function renderBoundedDiagnostics(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
  steps: ReportedFailedStep[],
): Promise<string[]> {
  const diagnostics = [
    `Result: ${input.result.status}`,
    `Update mode: ${sanitizeReportField(resolveUpdateMode(input), context)}`,
    `Reason code: ${sanitizeReportField(input.result.reason ?? "unknown", context)}`,
  ];
  if (input.result.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON) {
    diagnostics.push(`Advisory: ${LEGACY_UPDATE_RUN_ADVISORY}`);
  }
  if (input.result.reason === UPDATE_FOREIGN_DESTINATION_REASON) {
    diagnostics.push(`Next step: ${UPDATE_DESTINATION_RECOVERY}`);
  }
  for (const finding of normalizeUpdateDoctorLintFindings(
    input.result.steps.flatMap((step) => step.doctorLintFindings ?? []),
    context.env,
  )) {
    const { check } = await projectPublicUpdateFailureIdentifiers({
      check: finding.checkId,
      code: "doctor-failed",
    });
    const severity =
      finding.severity === "warning" || finding.severity === "info" ? finding.severity : "error";
    diagnostics.push(
      `Doctor lint ${severity} [${check}]: ${redactPublicSupportDiagnosticLine([finding.requirement, finding.message].filter(Boolean).join(": "), context)}`,
    );
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
    const message = [
      ...(step.failureFacts ?? []).flatMap((fact) => [fact.message, fact.code]),
      step.detail,
      step.stderrTail,
    ]
      .filter(Boolean)
      .join("\n");
    const diagnostic = redactPublicSupportDiagnosticLine(message, context);
    const exit = `exit ${step.exitCode ?? "unknown"}`;
    const detail =
      diagnostic === "[redacted-diagnostic]"
        ? exit
        : step.exitCode == null
          ? diagnostic
          : `${exit} (${diagnostic})`;
    diagnostics.push(`Failed phase ${phase}: ${detail}${termination}`);
    diagnostics.push(...formatNpmFailureFacts(step.failureFacts ?? [], context));
    diagnostics.push(
      ...(await Promise.all(
        normalizeUpdateFailureFacts(step.failureFacts ?? [], context.env)
          .filter((fact) => fact.check !== "npm")
          .map(async (fact) =>
            formatUpdateFailureFact({
              ...(await projectPublicUpdateFailureIdentifiers(fact)),
              ...(fact.location ? { location: fact.location } : {}),
              ...(fact.destination ? { destination: fact.destination } : {}),
              ...(fact.affectedKey ? { affectedKey: sanitizeFactConfigKey(fact.affectedKey) } : {}),
              ...(fact.message
                ? {
                    message:
                      updatePreflightDetailMessage(fact.code) ??
                      (fact.errorName
                        ? redactSupportDiagnosticLine(fact.message, context)
                        : redactPublicSupportDiagnosticLine(fact.message, context)),
                  }
                : {}),
            }),
          ),
      )),
    );
  }
  return diagnostics;
}

/** Builds the exact sanitized body the user must review before submission. */
export async function prepareUpdateFailureReport(
  request: UpdateFailureReportInput,
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): Promise<PreparedUpdateFailureReport> {
  if (!request.attemptId.trim()) {
    throw new Error("Update report attempt identity is required.");
  }
  if (classifyUpdateOutcome(request.result) !== "failed") {
    throw new Error("Only a final failed update can be reported.");
  }
  const recordedRun =
    request.recordedRun?.runId === request.attemptId ? request.recordedRun : undefined;
  const input = {
    ...request,
    recordedRun,
    result: {
      ...request.result,
      reason: request.result.reason ?? recordedRun?.reason ?? undefined,
      after: request.result.after ?? recordedRun?.after,
    },
  };
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const version = sanitizeReportField(VERSION, context);
  const platform = sanitizeReportField(`${process.platform}/${process.arch}`, context);
  const target = resolveUpdateTarget(input, context);
  const steps = resolveFailedSteps(input);
  const phase = sanitizeFactIdentifier(steps.at(-1)?.name ?? "not-recorded", context);
  const recovery = resolveRecoveryOutcome(input, context);
  const rollback = input.result.rollbackOutcome ?? recordedRun?.verification?.rollbackOutcome;
  const action = recordedRun?.trigger ?? input.action;
  const installation = recordedRun?.target?.installationMethod;
  const projection =
    input.result.verification || recordedRun?.verification
      ? updateRunReportInputFromResult(input.result, recordedRun)
      : undefined;
  const verification = projection?.verification;
  const identity = projection
    ? formatUpdateRunIdentity(projection.verification, projection.after)
    : undefined;
  const currentHealth = verification
    ? await readUpdateRunReportHealth(verification, { env })
    : undefined;
  const warnings = [
    ...new Set([
      ...(await Promise.all(
        (input.result.postUpdate?.plugins?.warnings ?? []).slice(-3).map(async (warning) => {
          const { code, pluginId } = await projectPublicUpdateFailureIdentifiers({
            check: "plugin-convergence",
            code: warning.reason,
            pluginId: warning.pluginId,
          });
          const diagnostic = redactPublicSupportDiagnosticLine(
            [warning.errorCode, warning.message].filter(Boolean).join("\n"),
            context,
          );
          return `Plugin convergence (${code})${pluginId ? `; plugin ${pluginId}` : ""}: ${diagnostic}`;
        }),
      )),
      ...updateRunWarningMessages([
        ...(recordedRun?.steps ?? []),
        ...updateRunReportInputFromResult(input.result).steps,
      ])
        .slice(-3)
        .map((message) => redactPublicSupportDiagnosticLine(message, context)),
    ]),
  ];
  const bodyWithoutMarker = [
    "# OpenClaw update failure report",
    "",
    "This report was explicitly reviewed and confirmed in OpenClaw.",
    "",
    `- OpenClaw version: ${version}`,
    `- Platform: ${platform}`,
    `- Node version: ${sanitizeReportField(process.versions.node ?? "unknown", context)}`,
    ...(action
      ? [
          `- Update action: ${action === "cli" ? "CLI command: openclaw update" : action === "campaign" ? "automatic update campaign" : `Gateway RPC: update.run (${action})`}`,
        ]
      : []),
    ...(installation ? [`- Installation method: ${installation}`] : []),
    `- Update target: ${target}`,
    `- Failed phase: ${phase}`,
    ...(rollback
      ? [
          `- Rollback outcome: ${{ "not-needed": "not needed", "not-attempted": "not attempted", succeeded: "attempted; succeeded", failed: "attempted; failed" }[rollback.status]} — ${redactSupportDiagnosticLine(rollback.reason, context)}`,
        ]
      : []),
    ...(recovery !== "not recorded" || !rollback ? [`- Recovery outcome: ${recovery}`] : []),
    ...(identity ? [`- Recorded verification: ${identity}`] : []),
    ...(currentHealth
      ? [
          `- ${formatUpdateRunCurrentHealth(
            currentHealth.kind === "responding"
              ? {
                  ...currentHealth,
                  version: redactPublicSupportVersion(currentHealth.version),
                }
              : currentHealth,
          )}`,
          "- Recovery and verification above describe the update attempt, not a current instruction to stop or restart the Gateway.",
        ]
      : []),
    ...(warnings.length ? ["", "## Warnings", "", ...warnings.map((line) => `- ${line}`)] : []),
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
  return {
    ...issue,
    attemptId: input.attemptId,
    previewDigest: createHash("sha256").update(issue.body).digest("hex"),
    savedReportPath: path.join(
      stateDir,
      "update-reports",
      `${createHash("sha256").update(input.attemptId).digest("hex")}.md`,
    ),
    ...(issue.browserFallback.status === "available" ? { url: issue.browserFallback.url } : {}),
  };
}
