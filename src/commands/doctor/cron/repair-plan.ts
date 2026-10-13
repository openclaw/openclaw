// Cron doctor repair planning helpers for previewing and merging legacy rows.
import { countLabel as pluralize } from "../../doctor-state-integrity-format.js";
import {
  IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  TASK_SUGGESTION_TOOL_NAME_MIGRATION,
} from "../shared/legacy-tool-name-migration.js";

type CronLegacyIssueCounts = Partial<Record<string, number>>;

function formatJobNameList(names: string[]): string {
  const preview = names.slice(0, 5).map((name) => `\`${name}\``);
  const remaining = names.length - preview.length;
  return `: ${preview.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

/**
 * Neither prompt shape is auto-repairable: command prompts lack proven shell access,
 * while supported shell-tool prompts keep running unchanged. Keep both out of --fix previews.
 */
export function formatUnresolvedPromptAdvisory(
  names: string[],
  kind: "command" | "shell",
): string | null {
  if (names.length === 0) {
    return null;
  }
  const singular = names.length === 1;
  return (
    kind === "command"
      ? [
          `${pluralize(names.length, "isolated automation")} ${singular ? "describes" : "describe"} a shell command in the agent prompt but ${singular ? "lacks" : "lack"} shell/process tool access${formatJobNameList(names)}.`,
          "- This is not the supported shell-tool prompt shape, so doctor cannot prove the job will execute the requested command.",
          '- Recreate it as a command automation (`openclaw automations add ... --command "<shell>"`) or grant explicit shell/process tool access before relying on it.',
        ]
      : [
          `${pluralize(names.length, "isolated automation")} ${singular ? "drives" : "drive"} shell/process tools from the agent prompt and ${singular ? "keeps" : "keep"} running as-is${formatJobNameList(names)}.`,
          "- This is a supported shape, not a legacy store row, so the doctor fix path cannot convert it and the finding is informational only.",
          '- For a deterministic run, recreate it as a command automation (`openclaw automations add ... --command "<shell>"`).',
        ]
  ).join("\n");
}

/** Advisory for jobs whose scheduled authority cannot be recovered without a caller decision. */
export function formatScheduledToolPolicyAdvisory(params: {
  legacyJobs: string[];
  invalidJobs: string[];
}): string | null {
  const lines: string[] = [];
  if (params.legacyJobs.length > 0) {
    lines.push(
      `${pluralize(params.legacyJobs.length, "tool-bearing cron job")} ${params.legacyJobs.length === 1 ? "keeps" : "keep"} legacy sender-policy resolution because an explicit tool cap or provable stored account identity is missing${formatJobNameList(params.legacyJobs)}.`,
    );
  }
  if (params.invalidJobs.length > 0) {
    lines.push(
      `${pluralize(params.invalidJobs.length, "tool-bearing cron job")} ${params.invalidJobs.length === 1 ? "has" : "have"} invalid or inconsistent scheduled authority provenance${formatJobNameList(params.invalidJobs)}.`,
    );
  }
  if (lines.length === 0) {
    return null;
  }
  lines.push(
    "- These jobs continue through restrictive sender-policy resolution; doctor will not infer authority from delivery or current configuration.",
    "- Recreate the job from a fresh authenticated creator turn, or reauthorize its complete tool cap from a trusted operator shell: `openclaw automations edit <id> --tools <tool,...>`.",
  );
  return lines.join("\n");
}

/** Advisory for alias-only jobs whose original exec authority cannot be proven from storage. */
export function formatLegacyGatewayExecAdvisory(names: string[]): string | null {
  if (names.length === 0) {
    return null;
  }
  return [
    `${pluralize(names.length, "automation")} ${names.length === 1 ? "grants" : "grant"} the retired \`gateway_exec\` alias${formatJobNameList(names)}.`,
    "- Doctor will not convert this alias to `exec` because the stored name does not prove its original producer or approval restrictions.",
    "- Recreate the automation from a fresh authenticated creator turn, or explicitly reauthorize its complete tool cap from a trusted operator shell.",
  ].join("\n");
}

export function formatLegacyIssuePreview(issues: CronLegacyIssueCounts): string[] {
  const descriptions: Record<string, string> = {
    jobId: "still uses legacy `jobId`",
    missingId: "is missing a canonical string `id`",
    nonStringId: "stores `id` as a non-string value",
    legacyScheduleString: "stores schedule as a bare string",
    legacyScheduleCron: "still uses `schedule.cron`",
    legacyScheduleKind:
      "stores a non-canonical schedule `kind` or stream `mode` that will be normalized",
    legacyPayloadKind: "needs payload kind normalization",
    legacyPayloadCodexModel: "still uses legacy `openai-codex/*` cron model refs",
    legacyTaskSuggestionToolName: `still grants legacy tool \`${TASK_SUGGESTION_TOOL_NAME_MIGRATION.legacyName}\`; doctor will rename it to \`${TASK_SUGGESTION_TOOL_NAME_MIGRATION.canonicalName}\``,
    legacyImageInspectionToolName: `still relies on legacy \`${IMAGE_INSPECTION_TOOL_NAME_MIGRATION.legacyName}\` coverage; doctor will preserve equivalent \`${IMAGE_INSPECTION_TOOL_NAME_MIGRATION.canonicalName}\` access`,
    legacyAgentTurnCommandPayload: "uses an agent prompt to run a shell command",
    legacyPayloadProvider: "still uses payload `provider` as a delivery alias",
    legacyTopLevelPayloadFields: "still uses top-level payload fields",
    legacyTopLevelDeliveryFields: "still uses top-level delivery fields",
    legacyDeliveryMode: "still uses delivery mode `deliver`",
    migratedScheduledToolPolicy:
      "can recover scheduled account authority from persisted owner identity",
    reconciledOwnerAccount:
      "can reconcile its owner account from persisted creator identity without changing tool permissions",
    invalidSchedule: "has an invalid persisted schedule and will be removed",
    invalidPayload: "has an invalid persisted payload and will be removed",
  };
  return Object.entries(descriptions).flatMap(([key, description]) => {
    const count = issues[key];
    return count ? [`- ${pluralize(count, "job")} ${description}`] : [];
  });
}

export function mergeRuntimeEntryIntoConfigJob(params: {
  job: Record<string, unknown>;
  runtimeEntry?: { updatedAtMs?: number; state?: Record<string, unknown> };
}): Record<string, unknown> {
  return {
    ...params.job,
    ...(params.runtimeEntry?.updatedAtMs !== undefined
      ? { updatedAtMs: params.runtimeEntry.updatedAtMs }
      : {}),
    ...(params.runtimeEntry?.state ? { state: structuredClone(params.runtimeEntry.state) } : {}),
  };
}
