import type { ChannelProgressDraftDiffStat } from "./progress-draft-diffstat.js";
import type { ChannelProgressDraftEventLineBuilder } from "./progress-draft-events.js";
import type {
  AgentPlanStep,
  ChannelProgressDraftLine,
  StreamingCompatEntry,
  StreamingMode,
} from "./streaming.js";

export type ChannelProgressDraftCompositorLine = string | ChannelProgressDraftLine;
export type ChannelProgressDraftCompositorSnapshot = Readonly<{
  lines: readonly ChannelProgressDraftCompositorLine[];
  label?: string;
  statusHeadline?: string;
  statusHeadlineFormat?: "plain";
  plan?: readonly AgentPlanStep[];
  planExplanation?: string;
  planExplanationFormat?: "plain";
  preparedBlocks?: readonly { text: string; format: "plain" | "markdown" }[];
  diffStat?: ChannelProgressDraftDiffStat;
}>;

type ChannelProgressDraftUpdateOptions = {
  flush?: boolean;
  lines: readonly ChannelProgressDraftCompositorLine[];
  snapshot: ChannelProgressDraftCompositorSnapshot;
};

export type ChannelProgressDraftCompositorParams = {
  /** @deprecated v2026.9.1 SDK presentation; retain until a breaking SDK release. */
  presentation?: "summary";
  entry: StreamingCompatEntry | null | undefined;
  mode: StreamingMode;
  active: boolean;
  seed: string;
  update: (
    text: string,
    options: ChannelProgressDraftUpdateOptions,
  ) => Promise<boolean | void> | boolean | void;
  deleteCurrent?: () => Promise<void> | void;
  tryNativeUpdate?: (text: string) => Promise<boolean> | boolean;
  /** Publish when structured lines change even if the rendered text does not. */
  updateOnLineChange?: boolean;
  /**
   * Set when the channel renders `update`'s structured `lines` itself, so the
   * composed text carries only the status block (label, headline, checklist).
   */
  rendersRollingLinesNatively?: boolean;
  formatLine?: (line: string) => string;
  formatPlainText?: (text: string) => string;
  isEmptyLine?: (line: ChannelProgressDraftCompositorLine | undefined) => boolean;
  shouldStartNow?: (line: ChannelProgressDraftCompositorLine | undefined) => boolean;
  reasoningLinePrefix?: string;
  commentaryLinePrefix?: string;
  reasoningGate?: boolean;
  commentaryItalics?: boolean;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Channel-specific formatter policy; event/lifecycle ownership remains in the compositor. */
  buildProgressEventLine?: ChannelProgressDraftEventLineBuilder;
};
