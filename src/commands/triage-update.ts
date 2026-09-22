// Preserve one failed update as bounded diagnostics across the updater's fresh CLI handoff.
import fs from "node:fs/promises";
import { z } from "zod";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { UpdateDoctorLintFindingSchema } from "../infra/update-doctor-lint-schema.js";
import { normalizeUpdateDoctorLintFindings } from "../infra/update-doctor-lint.js";
import { normalizeUpdateFailureFacts } from "../infra/update-failure-facts.js";
import { UpdateFailureFactSchema } from "../infra/update-run-schema.js";
import { formatUpdateDoctorLintReceipt, isFailedUpdateStep } from "../infra/update-run-step.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../utils/utf8-truncate.js";

const UPDATE_FAILURE_MAX_BYTES = 8 * 1024;
const UPDATE_FAILURE_PROMPT_MAX_BYTES = 4 * 1024;
const updateIdentitySchema = z.object({
  sha: z.string().nullish(),
  version: z.string().nullish(),
});
const createUpdateFailureSchema = <T extends z.ZodRawShape>(stepFields: T) =>
  z
    .union([
      z.object({
        result: z.object({
          runId: z.uuid().optional().catch(undefined),
          status: z.enum(["ok", "error", "skipped"]),
          mode: z.enum(["git", "pnpm", "bun", "npm", "unknown"]),
          root: z.string().optional(),
          reason: z.string().optional(),
          before: updateIdentitySchema.optional(),
          after: updateIdentitySchema.optional(),
          steps: z.array(
            z.object({
              name: z.string(),
              exitCode: z.number().int().nullable(),
              stdoutTail: z.string().nullish(),
              stderrTail: z.string().nullish(),
              failureFacts: z.array(UpdateFailureFactSchema).max(5).optional(),
              termination: z.enum(["exit", "timeout", "no-output-timeout", "signal"]).optional(),
              advisory: z
                .object({
                  kind: z.enum([
                    "package-post-install-doctor",
                    "candidate-runtime-unavailable",
                    "recoverable-maintenance",
                  ]),
                  message: z.string(),
                  details: z.array(z.string()).optional(),
                })
                .optional(),
              ...stepFields,
            }),
          ),
          recovery: z
            .object({
              serviceRestartSafe: z.boolean(),
              reason: z.string().optional(),
              packageRollbackVerified: z.boolean().optional(),
              version: z.string().optional(),
              buildId: z.string().optional(),
              service: z.enum(["healthy", "failed"]).optional(),
            })
            .optional(),
          postUpdate: z
            .object({
              plugins: z
                .object({
                  status: z.enum(["ok", "warning", "skipped", "error"]),
                  reason: z.string().optional(),
                  sync: z.object({ errors: z.array(z.string()) }).optional(),
                  npm: z
                    .object({
                      outcomes: z.array(
                        z.object({
                          pluginId: z.string(),
                          status: z.enum(["updated", "unchanged", "skipped", "error"]),
                          message: z.string(),
                        }),
                      ),
                    })
                    .optional(),
                  integrityDrifts: z
                    .array(
                      z.object({
                        pluginId: z.string(),
                        spec: z.string(),
                        expectedIntegrity: z.string(),
                        actualIntegrity: z.string(),
                      }),
                    )
                    .optional(),
                  warnings: z
                    .array(
                      z.object({
                        pluginId: z.string().optional(),
                        reason: z.string(),
                        message: z.string(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            })
            .optional(),
        }),
        error: z.string().trim().min(1).optional(),
        omittedDetails: z.number().int().nonnegative().optional(),
      }),
      z
        .object({
          error: z.string().trim().min(1),
          omittedDetails: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ])
    .refine(
      (failure) =>
        Boolean(failure.error) ||
        ("result" in failure && classifyUpdateOutcome(failure.result) === "failed"),
    );

export const updateFailureSchema = createUpdateFailureSchema({});
// Artifact inventories stay out of the repair-worker wire and bounded prompt contracts.
const updateFailureArtifactSchema = createUpdateFailureSchema({
  doctorLintFindings: z.array(UpdateDoctorLintFindingSchema).optional(),
  signal: z.string().max(32).nullable().optional(),
  killed: z.boolean().optional(),
  outputLimitExceeded: z.boolean().optional(),
});

/** Full UpdateRunResult values satisfy this diagnostic-only projection. */
export type TriageUpdateFailure = z.infer<typeof updateFailureArtifactSchema>;

export function sanitizeTriageUpdateFailure(
  input: unknown,
  redaction: SupportRedactionContext,
  format: "prompt" | "artifact" | "inventory" = "prompt",
): TriageUpdateFailure {
  const parsed = updateFailureArtifactSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid update failure diagnostics: expected a failed result or error.");
  }
  const failure = parsed.data;
  type Excerpt = "head" | "tail" | "ends";
  function text(value: string, maxBytes: number, excerpt?: Excerpt): string;
  function text(
    value: string | null | undefined,
    maxBytes: number,
    excerpt?: Excerpt,
  ): string | undefined;
  function text(
    value: string | null | undefined,
    maxBytes: number,
    excerpt: Excerpt = "head",
  ): string | undefined {
    if (value == null) {
      return undefined;
    }
    const redacted = redactSupportString(sanitizeForLog(value.replace(/\s+/gu, " ")), redaction, {
      maxLength: Number.MAX_SAFE_INTEGER,
    });
    if (Buffer.byteLength(JSON.stringify(redacted)) <= maxBytes) {
      return redacted;
    }
    // Reserve quotes and the omission marker; escaping also consumes the JSON field budget.
    let budget = maxBytes - 5;
    for (;;) {
      const headBytes = Math.floor(budget / 2);
      const bounded =
        excerpt === "tail"
          ? `...${truncateUtf8Suffix(redacted, budget)}`
          : excerpt === "ends"
            ? `${truncateUtf8Prefix(redacted, headBytes)}...${truncateUtf8Suffix(redacted, budget - headBytes)}`
            : `${truncateUtf8Prefix(redacted, budget)}...`;
      const bytes = Buffer.byteLength(JSON.stringify(bounded));
      if (bytes <= maxBytes) {
        return bounded;
      }
      budget = Math.floor((budget * (maxBytes - 5)) / (bytes - 5));
    }
  }
  let error = text(failure.error, 768, "ends");
  if (!("result" in failure)) {
    if (!error) {
      throw new Error("Update failure diagnostics contain no readable error.");
    }
    return { error, ...(failure.omittedDetails ? { omittedDetails: failure.omittedDetails } : {}) };
  }
  const result = failure.result;
  const lintReceipt = (step: (typeof result.steps)[number]) =>
    formatUpdateDoctorLintReceipt(
      {
        ...step,
        signal: step.signal === null ? null : text(step.signal, 32),
        doctorLintFindings: step.doctorLintFindings
          ? normalizeUpdateDoctorLintFindings(step.doctorLintFindings, redaction.env)
          : undefined,
      },
      384,
    );
  if (format === "artifact") {
    const lint =
      result.steps.findLast((step) => step.doctorLintFindings && isFailedUpdateStep(step)) ??
      result.steps.findLast((step) => step.doctorLintFindings);
    if (lint) {
      // Released 9.4 keeps only 160-byte step tails, but preserves this 768-byte field.
      const receipt = ` Doctor lint receipt: ${lintReceipt(lint)}`;
      error = `${text(error ?? result.reason ?? "Update failed", 768 - Buffer.byteLength(JSON.stringify(receipt)), "ends")}${receipt}`;
    }
  }
  const preserveFindings =
    format !== "prompt" && result.steps.some((step) => step.doctorLintFindings !== undefined);
  const identity = (value: typeof result.before) =>
    value ? { sha: text(value.sha, 48), version: text(value.version, 48) } : undefined;
  let omittedDetails = failure.omittedDetails ?? 0;
  let remainingPluginErrors = 3;
  const removePluginDetails: Array<() => void> = [];
  const takePluginErrors = <T>(
    values: T[] | undefined,
    latest = false,
    into?: T[],
  ): T[] | undefined => {
    const selected = values
      ? latest
        ? values.slice(Math.max(0, values.length - remainingPluginErrors))
        : values.slice(0, remainingPluginErrors)
      : undefined;
    remainingPluginErrors -= selected?.length ?? 0;
    omittedDetails += (values?.length ?? 0) - (selected?.length ?? 0);
    const output = into ?? selected;
    if (into && selected) {
      if (latest) {
        into.unshift(...selected);
      } else {
        into.push(...selected);
      }
    }
    for (const _ of selected ?? []) {
      removePluginDetails.push(() => {
        if (latest) {
          output?.shift();
        } else {
          output?.pop();
        }
      });
    }
    return output;
  };
  const plugins = result.postUpdate?.plugins;
  const pluginWarnings =
    plugins?.status === "error"
      ? plugins.warnings?.map((warning) => ({
          pluginId: text(warning.pluginId, 48),
          reason: text(warning.reason, 768, "ends"),
          message: text(warning.message, 64, "ends"),
        }))
      : undefined;
  // Fresh Doctor and config validation append terminal failures. Reserve the latest
  // warning before earlier errors, and retain it if whole-record pruning is needed.
  const warnings = takePluginErrors(pluginWarnings?.slice(-1));
  const postUpdate = plugins
    ? {
        plugins: {
          status: plugins.status,
          reason: text(plugins.reason, 96),
          warnings,
          sync: plugins.sync
            ? {
                errors:
                  takePluginErrors(
                    plugins.sync.errors.map((message) => text(message, 192, "ends")),
                  ) ?? [],
              }
            : undefined,
          npm: plugins.npm
            ? {
                outcomes:
                  takePluginErrors(
                    plugins.npm.outcomes
                      .filter((outcome) => outcome.status === "error")
                      .map((outcome) => ({
                        pluginId: text(outcome.pluginId, 48),
                        status: outcome.status,
                        message: text(outcome.message, 192, "ends"),
                      })),
                  ) ?? [],
              }
            : undefined,
          integrityDrifts: takePluginErrors(
            plugins.integrityDrifts?.map((drift) => ({
              pluginId: text(drift.pluginId, 48),
              spec: text(drift.spec, 64),
              expectedIntegrity: text(drift.expectedIntegrity, 64),
              actualIntegrity: text(drift.actualIntegrity, 64),
            })),
          ),
        },
      }
    : undefined;
  takePluginErrors(pluginWarnings?.slice(0, -1), true, warnings);
  const failedSteps = result.steps.filter(isFailedUpdateStep);
  const latest = new Set(failedSteps.slice(-3));
  const retained = new Set(
    result.steps.filter(
      (step) => latest.has(step) || (preserveFindings && step.doctorLintFindings !== undefined),
    ),
  );
  omittedDetails += failedSteps.filter((step) => !retained.has(step)).length;
  const sanitized = {
    ...(error ? { error } : {}),
    result: {
      ...(result.runId ? { runId: result.runId } : {}),
      status: result.status,
      mode: result.mode,
      reason: text(result.reason, 128),
      postUpdate,
      root: text(result.root, 96),
      before: identity(result.before),
      after: identity(result.after),
      recovery: result.recovery
        ? {
            serviceRestartSafe: result.recovery.serviceRestartSafe,
            reason: text(result.recovery.reason, 96),
            packageRollbackVerified: result.recovery.packageRollbackVerified,
            ...(result.recovery.serviceRestartSafe
              ? {
                  version: text(result.recovery.version, 48),
                  buildId: text(result.recovery.buildId, 96),
                  service: result.recovery.service,
                }
              : {}),
          }
        : undefined,
      // Prompt context keeps recent failures; artifacts also retain every lint inventory.
      steps: Array.from(retained, (step) => ({
        name: text(step.name, 64),
        exitCode: step.exitCode,
        termination: step.termination,
        signal:
          format !== "prompt" ? (step.signal === null ? null : text(step.signal, 32)) : undefined,
        killed: format !== "prompt" ? step.killed : undefined,
        outputLimitExceeded: format !== "prompt" ? step.outputLimitExceeded : undefined,
        // Failed-step stderr leads with the triggering error: keep both ends. The 384-byte cap's
        // tail half is wider than the previous tail-only window, so previously visible excerpts
        // remain visible; stdout keeps its tail-only outcome excerpt.
        stderrTail:
          format === "artifact" && step.doctorLintFindings
            ? lintReceipt(step)
            : text(step.stderrTail, 384, "ends"),
        stdoutTail: text(step.stdoutTail, 160, "tail"),
        failureFacts: step.failureFacts?.length
          ? normalizeUpdateFailureFacts(step.failureFacts, redaction.env)
          : undefined,
        doctorLintFindings:
          format === "inventory" && step.doctorLintFindings
            ? normalizeUpdateDoctorLintFindings(step.doctorLintFindings, redaction.env)
            : undefined,
        advisory:
          preserveFindings && step.advisory
            ? { kind: step.advisory.kind, message: text(step.advisory.message, 500) }
            : undefined,
      })),
    },
    omittedDetails,
  };
  // Fit whole records, retaining the latest failed step and at least one plugin cause.
  // Field caps reserve room for these plus identity and restart safety even after JSON escaping.
  if (format === "inventory" && preserveFindings) {
    return sanitized;
  }
  const maxBytes =
    format === "artifact" ? UPDATE_FAILURE_MAX_BYTES - 1 : UPDATE_FAILURE_PROMPT_MAX_BYTES;
  while (Buffer.byteLength(JSON.stringify(sanitized)) > maxBytes) {
    if (sanitized.result.steps.length > 1) {
      sanitized.result.steps.shift();
    } else if (removePluginDetails.length > 1) {
      removePluginDetails.pop()?.();
    } else if ((sanitized.result.steps[0]?.failureFacts?.length ?? 0) > 1) {
      sanitized.result.steps[0]?.failureFacts?.pop();
    } else {
      throw new Error(`Update failure diagnostics exceed the ${maxBytes}-byte limit.`);
    }
    sanitized.omittedDetails += 1;
  }
  return sanitized;
}

export async function readTriageUpdateFailure(
  inputPath: string,
  redaction: SupportRedactionContext,
): Promise<TriageUpdateFailure> {
  const file = await fs.open(inputPath, "r");
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error("Update failure diagnostics must be a regular file.");
    }
    const raw = await readFileDescriptorBounded(file.fd, UPDATE_FAILURE_MAX_BYTES);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      throw new Error("Invalid update failure diagnostics JSON.");
    }
    return sanitizeTriageUpdateFailure(input, redaction, "artifact");
  } finally {
    await file.close();
  }
}

export async function readPendingTriageUpdateFailure(
  env: NodeJS.ProcessEnv,
  redaction: SupportRedactionContext,
): Promise<TriageUpdateFailure | undefined> {
  // Diagnostic evidence only; the resolution owner selects current ledger history.
  const { readRestartSentinelReadOnly } = await import("../infra/restart-sentinel.js");
  const sentinel = await readRestartSentinelReadOnly(env);
  if (sentinel?.payload.kind !== "update") {
    return undefined;
  }
  const { payload } = sentinel;
  const stats = payload.stats;
  if (
    classifyUpdateOutcome({ status: payload.status, reason: stats?.reason ?? undefined }) !==
    "failed"
  ) {
    return undefined;
  }
  return sanitizeTriageUpdateFailure(
    {
      result: {
        ...(stats?.runId ? { runId: stats.runId } : {}),
        status: payload.status,
        mode: stats?.mode ?? "unknown",
        root: stats?.root,
        reason: stats?.reason ?? undefined,
        before: stats?.before ?? undefined,
        after: stats?.after ?? undefined,
        recovery: stats?.recovery,
        steps: (stats?.steps ?? []).map((step) => ({
          name: step.name,
          exitCode: step.log?.exitCode ?? null,
          stderrTail: step.log?.stderrTail,
          stdoutTail: step.log?.stdoutTail,
          failureFacts: step.failureFacts,
        })),
      },
    },
    redaction,
  );
}
