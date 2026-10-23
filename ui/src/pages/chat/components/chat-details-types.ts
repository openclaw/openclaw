import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import type { ChatSessionProgressProps } from "./chat-composer-types.ts";
import type { ChatOutputsDesktopProps } from "./chat-outputs.tsx";
import type { ChatPanePlacementProps } from "./chat-pane-placement.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

type ChatDetailsWorkspace = { root: string | null; label: string | null; branch?: string };

export type ChatDetailsDesktopSectionId =
  | "people"
  | "environment"
  | "context"
  | "pull-requests"
  | "automations"
  | "subagents"
  | "processes"
  | "outputs";

export type ChatDetailsEnvironmentProps = {
  details: ChatDetailsProps;
  presented: boolean;
  /** The parent's in-memory disclosure choice; no second preference store. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onOpenProject?: () => void;
  onOpenMachine?: () => void;
  /** The same checkout's Uncommitted result owned by Review, never a new query. */
  uncommitted?: SessionsDiffResult;
  /** Demand the checkout owner's result while this environment is presented. */
  onRequestUncommitted?: () => void | (() => void);
  onOpenUncommitted?: () => void;
};

export type ChatDetailsEnvironmentDesktopProps = ChatDetailsEnvironmentProps & {
  work?: ChatPullRequestsProps;
  /** Forward the native header's placement facts/actions; mobile has its own destination. */
  placement?: ChatPanePlacementProps;
};

type ChatDetailsDesktopDisclosures = {
  /** Restored by the preference owner before the first render, scoped to this session. */
  expanded: Partial<Record<ChatDetailsDesktopSectionId, boolean>>;
  onExpandedChange: (section: ChatDetailsDesktopSectionId, expanded: boolean) => void;
};

type ChatDetailsDesktopPresentation = {
  /** Localized section labels supplied by the host's copy owner. */
  peopleLabel: string;
  outputsLabel: string;
  /** Localized Working, without the ellipsis in common.working. */
  subagentsWorkingLabel: string;
};

type ChatDetailsEnvironmentData = Pick<
  ChatDetailsEnvironmentDesktopProps,
  | "onOpenProject"
  | "onOpenMachine"
  | "uncommitted"
  | "onRequestUncommitted"
  | "onOpenUncommitted"
  | "placement"
>;

/** Published assistant-artifact/dashboard facts and real destination/icon operations. */
export type ChatDetailsOutputs = ChatOutputsDesktopProps;

// Both the composing view and Details consume this contract; child components
// must not import their parent renderer to recover accepted pane facts.
export type ChatDetailsProps = ChatSessionProgressProps &
  Pick<
    ChatThreadProps,
    | "selectedSession"
    | "subagentSessions"
    | "subagentParentKey"
    | "subagentSessionsHydrated"
    | "subagentSessionsRead"
    | "onOpenSubagent"
    | "onOpenSubagents"
    | "personActivity"
    | "onScrollPortRef"
  > & {
    desktopPresentation?: ChatDetailsDesktopPresentation;
    desktopDisclosures?: ChatDetailsDesktopDisclosures;
    environment?: ChatDetailsEnvironmentData;
    outputs?: ChatDetailsOutputs;
    /** Stable per native resource identity; acquire only while Details is presented. */
    retainOutputs?: () => (() => void) | undefined;
    /** Details consumes the unfiltered progress projection, independently of Show in chat. */
    progressCardError?: "access-denied" | "unavailable";
    showTaskProgress?: boolean;
    onShowTaskProgressChange?: (shown: boolean) => void;
    onSessionSelect?: (sessionKey: string) => void;
    detailsWorkspace?: ChatDetailsWorkspace;
    onHideTaskProgress?: () => void;
    onCollapseTaskProgressChange?: (collapsed: boolean) => void;
    onOpenTaskProgressSettings?: () => void;
    pullRequests?: ControlUiSessionPullRequest[];
    pullRequestsGateway?: ApplicationGateway;
    pullRequestsSessionId?: string;
    pullRequestsBranch?: ControlUiSessionBranch;
    pullRequestsBranchDismissed?: boolean;
    pullRequestsStatus?: ControlUiSessionPullRequestSnapshot["status"];
    onOpenSessionDiff?: () => void;
    onOpenWorkspace?: () => void;
    /** Opens this pane's Processes panel; absent where the pane has none. */
    onOpenProcesses?: () => void;
    onCompact?: () => void | Promise<unknown>;
    onDismissPullRequest?: (pullRequest: ControlUiSessionPullRequest) => void;
    onDismissPullRequestsBranch?: (branch: ControlUiSessionBranch) => void;
    githubPublication?: GitHubPublicationView;
  };
