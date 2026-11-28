import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { z } from "zod";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { formatStateLeaseLoss } from "../shared/state-lease-loss-format.js";
import { UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type {
  UpdateDestinationFailureSchema,
  UpdateFailureFactSchema,
} from "./update-run-schema.js";

export type UpdateFailureFact = z.infer<typeof UpdateFailureFactSchema>;

export type UpdateDestinationFailure = z.infer<typeof UpdateDestinationFailureSchema>;

export const UPDATE_DESTINATION_RECOVERY =
  "Use the destination's owning installation and service account, or correct the npm prefix mismatch before retrying: https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions. Do not overwrite another installation.";

/** Paths are normalized before recording; this projection also runs in the browser. */
function formatUpdateDestinationFailure(fact: UpdateDestinationFailure): string {
  const paths = [
    ["prefix", fact.prefix],
    ["package", fact.packageRoot],
    ["running install", fact.runningRoot],
    ["running prefix", fact.runningPrefix],
    ["launcher", fact.launcher],
    ["launcher target", fact.launcherTarget],
  ] as const;
  return [
    `Warning: npm destination ownership ${fact.ownership}; cause ${fact.cause}; kind ${fact.destinationKind}`,
    ...paths.flatMap(([label, value]) => (value === null ? [] : [`${label} \`${value}\``])),
    `Next step: ${UPDATE_DESTINATION_RECOVERY}`,
  ].join("; ");
}

/** Keep the first failing check visible when later recovery failures fill the summary. */
export function selectUpdateFailureReportSteps<
  T extends { failureFacts?: readonly UpdateFailureFact[] },
>(steps: readonly T[]): readonly T[] {
  const recent = steps.slice(-3);
  const firstFact = steps.find((step) => (step.failureFacts?.length ?? 0) > 0);
  return firstFact && !recent.includes(firstFact) ? [firstFact, ...recent.slice(-2)] : recent;
}

/** Render producer-redacted facts in both server and browser reports. */
export function formatUpdateFailureFact(fact: UpdateFailureFact): string {
  const message = fact.destination
    ? formatUpdateDestinationFailure(fact.destination)
    : fact.message;
  return `Failing check ${fact.check} (${fact.code})${fact.location ? ` at ${fact.location}` : ""}${fact.pluginId ? `; plugin ${fact.pluginId}` : ""}${fact.affectedKey ? `; key ${fact.affectedKey}` : ""}${message ? `: ${message}` : ""}${fact.leaseLoss ? `; ${formatStateLeaseLoss(fact.leaseLoss)}` : ""}`;
}

/** Typed by the fields it reads: this browser-safe module must not import the run record. */
export function formatRepairedUpdateRun(run: {
  runId: string;
  reason: string | null;
  target: { version?: string | null };
  after: { version?: string | null };
  steps: readonly {
    step: string;
    status: string;
    detail?: string | null;
    failureFacts?: readonly UpdateFailureFact[];
  }[];
}): string {
  const version = run.target.version ?? run.after.version;
  const phase = run.steps.find(
    (step) => UPDATE_RUN_PHASES.some((name) => name === step.step) && step.status === "failed",
  );
  const failure = selectUpdateFailureReportSteps(
    run.steps.filter(
      (step) => step.status === "failed" && !UPDATE_RUN_PHASES.some((name) => name === step.step),
    ),
  )[0];
  const text = `Update ${run.runId}${version ? ` to ${version}` : ""} failed${phase ? ` at ${phase.step}` : ""}: ${run.reason ?? "unknown reason"}.${failure?.detail ? ` ${failure.step}: ${failure.detail}` : ""}`;
  return text.length <= UPDATE_RUN_TEXT_LIMIT
    ? text
    : `${sliceUtf16Safe(text, 0, UPDATE_RUN_TEXT_LIMIT - 1)}…`;
}
