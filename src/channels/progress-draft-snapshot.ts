import { redactToolPayloadText } from "../logging/redact.js";
import type {
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorParams,
  ChannelProgressDraftCompositorSnapshot,
} from "./progress-draft-compositor.types.js";
import {
  copyProgressDraftLineMetadata,
  resolveChannelProgressDraftConfig,
  resolveChannelProgressDraftLabel,
  type AgentPlanStep,
} from "./streaming.js";

/** Own public display data before adapters render it or receipts retain it. */
export function redactProgressDraftLine(
  line: ChannelProgressDraftCompositorLine,
): ChannelProgressDraftCompositorLine {
  if (typeof line === "string") {
    return redactToolPayloadText(line);
  }
  // Keep opaque event IDs stable; commentary sanitizes text before deriving an ID.
  const redacted = {
    ...line,
    text: redactToolPayloadText(line.text),
    label: redactToolPayloadText(line.label),
    ...(line.detail !== undefined ? { detail: redactToolPayloadText(line.detail) } : {}),
    ...(line.status !== undefined ? { status: redactToolPayloadText(line.status) } : {}),
    ...(line.icon !== undefined ? { icon: redactToolPayloadText(line.icon) } : {}),
    ...(line.toolName !== undefined ? { toolName: redactToolPayloadText(line.toolName) } : {}),
  };
  copyProgressDraftLineMetadata(line, redacted);
  return redacted;
}

export function redactProgressPlanSteps(
  steps?: readonly AgentPlanStep[],
): AgentPlanStep[] | undefined {
  return steps?.map((step) => ({ ...step, step: redactToolPayloadText(step.step) }));
}

export function createProgressDraftSnapshotState(
  params: Pick<ChannelProgressDraftCompositorParams, "entry" | "initialSnapshot">,
) {
  const snapshot = params.initialSnapshot;
  return {
    displayEntry: snapshot
      ? {
          streaming: {
            progress: {
              ...resolveChannelProgressDraftConfig(params.entry),
              label: snapshot.label === undefined ? false : redactToolPayloadText(snapshot.label),
            },
          },
        }
      : params.entry,
    transferredStatus: snapshot?.statusHeadline
      ? {
          text: redactToolPayloadText(snapshot.statusHeadline),
          format: snapshot.statusHeadlineFormat,
        }
      : undefined,
    // Without file identities a transferred total cannot deduplicate later mutations.
    transferredDiffStat: snapshot?.diffStat ? { ...snapshot.diffStat } : undefined,
    lines: snapshot?.lines.map(redactProgressDraftLine) ?? [],
    planSteps: redactProgressPlanSteps(snapshot?.plan),
    planExplanation: redactToolPayloadText(snapshot?.planExplanation ?? ""),
    planExplanationFormat: snapshot?.planExplanationFormat,
  };
}

export function snapshotProgressDraftState(params: {
  entry: ChannelProgressDraftCompositorParams["entry"];
  seed: string;
  status: { text: string; format?: "plain" };
  lines: readonly ChannelProgressDraftCompositorLine[];
  plan?: readonly AgentPlanStep[];
  planExplanation: string;
  planExplanationFormat?: "plain";
  diffStat?: ChannelProgressDraftCompositorSnapshot["diffStat"];
}): ChannelProgressDraftCompositorSnapshot {
  const statusHeadline = params.status.text;
  const label = resolveChannelProgressDraftLabel({
    entry: params.entry,
    seed: params.seed,
    narration: statusHeadline,
  });
  return {
    lines: params.lines.map((line) => (typeof line === "string" ? line : { ...line })),
    ...(label ? { label } : {}),
    ...(statusHeadline ? { statusHeadline } : {}),
    ...(statusHeadline && params.status.format
      ? { statusHeadlineFormat: params.status.format }
      : {}),
    ...(params.plan ? { plan: params.plan.map((step) => ({ ...step })) } : {}),
    ...(params.planExplanation ? { planExplanation: params.planExplanation } : {}),
    ...(params.planExplanation && params.planExplanationFormat
      ? { planExplanationFormat: params.planExplanationFormat }
      : {}),
    ...(params.diffStat ? { diffStat: params.diffStat } : {}),
  };
}
