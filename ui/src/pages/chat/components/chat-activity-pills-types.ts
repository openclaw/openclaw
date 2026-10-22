import type { ProgressCard, SessionRunStatus } from "@openclaw/gateway-protocol";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { SessionGoal } from "../../../api/types.ts";
import type { ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import type { SessionProgressCardRefreshState } from "../../../lib/session-progress-cards.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import type { ComposerActivityLayout } from "./chat-transcript-layout-owner.ts";

type OpenActivity = (source: HTMLButtonElement) => void;

/** Mount only in the native mobile presentation branch, not a narrow desktop pane. */
export type ChatActivityPillsProps = {
  onLayout?: (layout: ComposerActivityLayout, detached?: boolean) => void;
  presented: boolean;
  approvalPending: boolean;
  subagents?: { activities: readonly ChatSubagentActivity[]; onOpen: OpenActivity };
  goal?: {
    value: SessionGoal;
    /** Confirmed direct execution, never queued/submitted/accepted Resume alone. */
    executionConfirmed: boolean;
    recovery?: ChatGoalRecovery;
    /** Only an explicit user hide; completion, idle and approval do not set this. */
    hidden?: boolean;
    onOpen: OpenActivity;
  };
  progress?: {
    card: ProgressCard;
    showInChat: boolean;
    sessionStatus?: SessionRunStatus;
    startedAt?: number;
    endedAt?: number;
    hasActiveRun: boolean;
    refresh?: SessionProgressCardRefreshState;
    onOpen: OpenActivity;
  };
  pullRequests?: {
    /** Native visible collection, already ordered and filtered by its owner. */
    items: readonly ControlUiSessionPullRequest[];
    status: ControlUiSessionPullRequestSnapshot["status"];
    onOpen: (pullRequest: ControlUiSessionPullRequest, source: HTMLButtonElement) => void;
  };
  /** Supply only an eligible branch offer or retained publication owned by this session. */
  publication?: { view: GitHubPublicationView; onOpen: OpenActivity };
};
