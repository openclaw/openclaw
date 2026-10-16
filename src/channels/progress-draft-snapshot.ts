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

function copyProgressDraftLine(
  line: ChannelProgressDraftCompositorLine,
): ChannelProgressDraftCompositorLine {
  if (typeof line === "string") {
    return line;
  }
  const copy = { ...line };
  copyProgressDraftLineMetadata(line, copy);
  return copy;
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
              label: snapshot.label === undefined ? false : snapshot.label,
            },
          },
        }
      : params.entry,
    transferredStatus: snapshot?.statusHeadline
      ? {
          text: snapshot.statusHeadline,
          format: snapshot.statusHeadlineFormat,
        }
      : undefined,
    // Without file identities a transferred total cannot deduplicate later mutations.
    transferredDiffStat: snapshot?.diffStat ? { ...snapshot.diffStat } : undefined,
    lines: snapshot?.lines.map(copyProgressDraftLine) ?? [],
    planSteps: snapshot?.plan?.map((step) => ({ ...step })),
    planExplanation: snapshot?.planExplanation ?? "",
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
