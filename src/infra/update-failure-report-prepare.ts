/** Sanitizes and prepares one explicitly reviewed update-failure report. */
import { isIP } from "node:net";
import { constants } from "node:os";
import { valid as validSemver } from "semver";
import { resolveStateDir } from "../config/paths.js";
import {
  publicConfigIssueMessage,
  redactPublicSupportConfigKey,
  redactPublicSupportDiagnosticLine,
  redactPublicSupportVersion,
  redactSupportDiagnosticLine,
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { isReportableUpdateRun } from "../shared/update-outcome-classification.js";
import { UPDATE_FOREIGN_DESTINATION_REASON } from "../shared/update-outcome.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";
import { sha256Hex } from "./crypto-digest.js";
import { prepareGithubIssue, type PreparedGithubIssue } from "./github-issue.js";
import { PACKAGE_REFUSAL_CODES } from "./package-update-refusal.js";
import {
  formatUpdateFailureFact,
  selectUpdateFailureReportSteps,
  UPDATE_DESTINATION_RECOVERY,
} from "./update-failure-facts-format.js";
import { normalizeUpdateFailureFacts } from "./update-failure-facts.js";
import { projectPublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";
import { formatNpmFailureFacts } from "./update-npm-failure.js";
import { updatePreflightDetailMessage } from "./update-preflight-details.js";
import { classifyUpdateRunCause } from "./update-run-cause.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { resolvePublicUpdateStepId } from "./update-step-identity.js";
import type { UpdateStepResult } from "./update-step-result.js";

const UPDATE_REPORT_BODY_MAX_BYTES = 16_000;
const UPDATE_REPORT_FIELD_MAX_BYTES = 512;

export type PreparedUpdateFailureReport = PreparedGithubIssue & {
  attemptId: string;
  previewDigest: string;
};

type UpdateFailureReportContext = SupportRedactionContext;

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
  const redacted = redactSupportString(redactDiagnosticLines(text), context);
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

type ReportedFailedStep = Pick<
  UpdateStepResult,
  "name" | "exitCode" | "termination" | "failureFacts" | "stderrTail"
> & { detail?: string; signal?: string | null };

function resolveFailedSteps(input: UpdateRunRecord): ReportedFailedStep[] {
  return input.steps
    .filter((step) => step.status === "failed")
    .map((step) => ({
      name: step.step,
      exitCode: step.exitCode ?? null,
      termination: step.termination,
      signal: step.signal,
      failureFacts: step.failureFacts,
      detail: step.detail,
      stderrTail: step.stderrTail,
    }));
}

function resolveUpdateTarget(input: UpdateRunRecord, context: UpdateFailureReportContext): string {
  const target = input.target;
  return sanitizeReportField(
    target.sha || target.version || target.tag || target.channel || "not-recorded",
    context,
  );
}

async function renderBoundedDiagnostics(
  input: UpdateRunRecord,
  context: UpdateFailureReportContext,
  steps: ReportedFailedStep[],
): Promise<string[]> {
  const diagnostics = [
    `Result: ${input.status}`,
    `Update mode: ${sanitizeReportField(input.target.kind ?? "unknown", context)}`,
    `Reason code: ${sanitizeReportField(input.reason ?? "unknown", context)}`,
    `Cause: ${classifyUpdateRunCause({
      status: input.status,
      reason: input.reason,
      facts: steps.flatMap((step) => step.failureFacts ?? []),
    })}`,
  ];
  if (input.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON) {
    diagnostics.push(`Advisory: ${LEGACY_UPDATE_RUN_ADVISORY}`);
  }
  if (input.reason === UPDATE_FOREIGN_DESTINATION_REASON) {
    diagnostics.push(`Next step: ${UPDATE_DESTINATION_RECOVERY}`);
  }
  // Reviewed identity facts also bind consent when the run ID stays the same.
  for (const [label, identity] of [
    ["Before", input.before],
    ["After", input.after],
  ] as const) {
    for (const field of ["version", "sha"] as const) {
      if (identity?.[field]) {
        diagnostics.push(`${label} ${field}: ${sanitizeReportField(identity[field], context)}`);
      }
    }
  }
  if (input.after?.buildId) {
    diagnostics.push(`After build: ${sanitizeReportField(input.after.buildId, context)}`);
  }
  for (const step of selectUpdateFailureReportSteps(steps)) {
    const phase = sanitizeFactIdentifier(step.name, context);
    const signal =
      step.signal && Object.hasOwn(constants.signals, step.signal) ? step.signal : null;
    const termination = step.termination
      ? `, termination ${step.termination}${signal ? ` (${signal})` : ""}`
      : "";
    const message = [
      ...(step.failureFacts ?? []).flatMap((fact) => [fact.message, fact.code]),
      step.detail,
      step.stderrTail,
    ]
      .filter(Boolean)
      .join("\n");
    const facts = normalizeUpdateFailureFacts(step.failureFacts ?? [], context.env);
    const refused = PACKAGE_REFUSAL_CODES.some((code) => facts.some((f) => f.code === code));
    const npm = facts.find(
      (fact) => (fact.check === "npm" || fact.check === "bun") && fact.npmErrorCode,
    );
    const publicFacts = await Promise.all(
      facts.map(async (fact) => {
        const identifiers = await projectPublicUpdateFailureIdentifiers(fact);
        const affectedKey = fact.affectedKey
          ? redactPublicSupportConfigKey(fact.affectedKey, context.redactConfigPathSegment)
          : undefined;
        const issueKind = publicConfigIssueMessage({
          path: fact.affectedKey ?? "",
          message: fact.message ?? "",
        });
        const publicMessage =
          affectedKey &&
          (fact.code === "invalid-config" ||
            fact.code === "candidate-config-failed" ||
            issueKind !== "Invalid configuration field")
            ? issueKind
            : (updatePreflightDetailMessage(fact.code) ??
              redactPublicSupportDiagnosticLine(fact.message ?? "", context));
        return {
          ...identifiers,
          affectedKey,
          ...(fact.location ? { location: fact.location } : {}),
          ...(fact.destination ? { destination: fact.destination } : {}),
          ...(fact.leaseLoss ? { leaseLoss: fact.leaseLoss } : {}),
          ...(!refused ? { message: publicMessage } : {}),
        };
      }),
    );
    const diagnostic = refused
      ? "[redacted-diagnostic]"
      : npm
        ? [npm.npmErrorCode, npm.packageSpec].filter(Boolean).join(" ")
        : truncateUtf8Prefix(
            [
              ...new Set(
                [
                  redactPublicSupportDiagnosticLine(message, context),
                  ...publicFacts
                    .filter((fact) => fact.message && fact.message !== "[redacted-diagnostic]")
                    .map(
                      (fact) =>
                        `${fact.affectedKey ? `${fact.affectedKey}: ` : ""}${fact.message}${fact.pluginId && fact.pluginId !== "[redacted-plugin]" ? `: ${fact.pluginId}` : ""}`,
                    ),
                ]
                  .flatMap((line) => line.split("; "))
                  .filter((line) => line && line !== "[redacted-diagnostic]"),
              ),
            ].join("; "),
            200,
          ) || "[redacted-diagnostic]";
    const exit = `exit ${step.exitCode ?? "unknown"}`;
    const publicDetail = diagnostic === "[redacted-diagnostic]" ? undefined : diagnostic;
    const detail = !publicDetail
      ? exit
      : step.exitCode == null
        ? publicDetail
        : `${exit} (${publicDetail})`;
    diagnostics.push(`Failed phase ${phase}: ${detail}${termination}`);
    diagnostics.push(...formatNpmFailureFacts(facts, context));
    diagnostics.push(
      ...publicFacts
        .filter((fact) => fact.check !== "npm" && fact.check !== "bun")
        .map(formatUpdateFailureFact),
    );
    if (
      !refused &&
      publicFacts.some(
        (fact, index) => facts[index]?.message && fact.message !== facts[index]?.message,
      )
    ) {
      diagnostics.push("Details retained locally in `openclaw update status --json`.");
    }
  }
  return diagnostics;
}

/** Builds the exact sanitized body the user must review before submission. */
export async function prepareUpdateFailureReport(
  input: UpdateRunRecord,
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): Promise<PreparedUpdateFailureReport> {
  if (!input.runId.trim()) {
    throw new Error("Update report attempt identity is required.");
  }
  if (!isReportableUpdateRun(input)) {
    throw new Error("Only a final failed update can be reported.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const { buildConfigSchemaCore, classifyConfigSchemaPathSegment } =
    await import("../config/schema.js");
  const schema = buildConfigSchemaCore();
  const context: UpdateFailureReportContext = {
    env,
    stateDir,
    redactConfigPathSegment: (parentParts, segment) => {
      // Runtime admission reports the package's engine field, outside the config schema.
      if (
        (parentParts.length === 0 && segment === "engines") ||
        (parentParts.length === 1 && parentParts[0] === "engines" && segment === "node")
      ) {
        return segment;
      }
      const kind = classifyConfigSchemaPathSegment(schema, parentParts, segment);
      if (kind === "property" || kind === "array-index") {
        return segment;
      }
      return kind === "record-key" || kind === "invalid-record-key" ? "<id>" : "<key>";
    },
  };
  const version = sanitizeReportField(VERSION, context);
  const platform = sanitizeReportField(`${process.platform}/${process.arch}`, context);
  const target = resolveUpdateTarget(input, context);
  const steps = resolveFailedSteps(input);
  const phase = sanitizeFactIdentifier(steps.at(-1)?.name ?? "not-recorded", context);
  const { rollbackOutcome: rollback, recovery, runningVersion } = input.verification;
  const bodyWithoutMarker = [
    "# OpenClaw update failure report",
    "",
    "This report was explicitly reviewed and confirmed in OpenClaw.",
    "",
    `- OpenClaw version: ${version}`,
    `- Platform: ${platform}`,
    `- Node version: ${sanitizeReportField(process.versions.node ?? "unknown", context)}`,
    `- Attempt: ${sha256Hex(input.runId)}`,
    `- Update action: ${sanitizeReportField(input.trigger, context)}`,
    ...(input.target.installationMethod
      ? [`- Installation method: ${sanitizeReportField(input.target.installationMethod, context)}`]
      : []),
    `- Update target: ${target}`,
    `- Failed phase: ${phase}`,
    ...(rollback
      ? [
          `- Rollback outcome: ${{ "not-needed": "not needed", "not-attempted": "not attempted", succeeded: "attempted; succeeded", failed: "attempted; failed" }[rollback.status]} — ${redactSupportDiagnosticLine(rollback.reason, context)}`,
        ]
      : []),
    ...(recovery
      ? [
          `- Recovery outcome: ${recovery.serviceRestartSafe ? "restart safe" : "restart unverified"}; ${sanitizeReportField(recovery.reason ?? "not-recorded", context)}`,
          ...(recovery.serviceRestartSafe
            ? [`- Recovery version: ${redactPublicSupportVersion(recovery.version)}`]
            : []),
        ]
      : []),
    ...(runningVersion
      ? [`- Recorded running version: ${redactPublicSupportVersion(runningVersion)}`]
      : []),
    ...(
      [
        "booted",
        "serviceRunning",
        "versionMatch",
        "channelsReady",
        "readyz",
        "coreReady",
        "settled",
      ] as const
    )
      .filter((key) => input.verification[key] !== undefined)
      .map((key) => `- Recorded ${key}: ${input.verification[key]}`),
    "",
    "## Bounded diagnostics",
    "",
    ...(await renderBoundedDiagnostics(input, context, steps)).map((line) => `- ${line}`),
    "",
  ].join("\n");
  const body = truncateUtf8Prefix(bodyWithoutMarker, UPDATE_REPORT_BODY_MAX_BYTES);
  const title = truncateUtf8Prefix(`Update failure: ${phase} (${version})`, 200).replace(
    /\s+/gu,
    " ",
  );
  const issue = prepareGithubIssue({ title, body });
  return {
    ...issue,
    attemptId: input.runId,
    previewDigest: sha256Hex(issue.body),
  };
}
