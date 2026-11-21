import type {
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorParams,
  ChannelProgressDraftCompositorSnapshot,
} from "./progress-draft-compositor.types.js";
import {
  resolveChannelProgressDraftConfig,
  formatChannelProgressDraftTextForStreaming,
  resolveChannelProgressDraftLabel,
  type AgentPlanStep,
} from "./streaming.js";

export function formatProgressDraftSnapshot(
  params: ChannelProgressDraftCompositorParams,
  state: {
    entry: ChannelProgressDraftCompositorParams["entry"];
    snapshot: ChannelProgressDraftCompositorSnapshot;
    formatted?: boolean;
    onPreparedBlocks?: (blocks: Array<{ text: string; format: "plain" | "markdown" }>) => void;
  },
) {
  const snapshot = state.snapshot;
  const narration = snapshot.statusHeadline;
  const linesRenderedByChannel =
    params.rendersRollingLinesNatively === true && Boolean(narration || snapshot.plan?.length);
  return formatChannelProgressDraftTextForStreaming({
    presentation: params.presentation,
    entry: state.entry,
    lines: linesRenderedByChannel ? [] : [...snapshot.lines],
    seed: params.seed,
    formatLine: state.formatted === false ? undefined : params.formatLine,
    formatPlainText: state.formatted === false ? (text) => text : params.formatPlainText,
    onPreparedBlocks: state.onPreparedBlocks,
    narration,
    narrationFormat: snapshot.statusHeadlineFormat,
    plan: snapshot.plan,
    diffStat: snapshot.diffStat,
  });
}

/** Authorship follows the snapshot accepted by the transport, not its encoding. */
export function resolveProgressDraftAuthoredText(
  snapshot: ChannelProgressDraftCompositorSnapshot,
  preamble: string,
): string | undefined {
  return (
    [
      snapshot.statusHeadline === preamble ? preamble : "",
      ...snapshot.lines.flatMap((line) =>
        typeof line === "object" && line.kind === "item" && line.label === "Commentary"
          ? [line.text]
          : [],
      ),
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
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
    transferredDiffStat: snapshot?.diffStat,
    lines: snapshot ? [...snapshot.lines] : [],
    planSteps: snapshot?.plan,
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
    lines: params.lines,
    ...(label ? { label } : {}),
    ...(statusHeadline ? { statusHeadline } : {}),
    ...(statusHeadline && params.status.format
      ? { statusHeadlineFormat: params.status.format }
      : {}),
    ...(params.plan ? { plan: params.plan } : {}),
    ...(params.planExplanation ? { planExplanation: params.planExplanation } : {}),
    ...(params.planExplanation && params.planExplanationFormat
      ? { planExplanationFormat: params.planExplanationFormat }
      : {}),
    ...(params.diffStat ? { diffStat: params.diffStat } : {}),
  };
}
