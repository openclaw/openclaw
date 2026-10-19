import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import type { ChatSessionProgressProps } from "./chat-composer-types.ts";
import type { ChatDetailsEnvironmentDesktopProps } from "./chat-details-environment.tsx";
import type { ChatOutputsDesktopProps } from "./chat-outputs.tsx";
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
export type ChatDetailsOutputsIcons = Pick<
  ChatDetailsOutputs,
  "renderArtifactIcon" | "renderViewAllIcon"
>;

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
    | "onScrollPortRef"
  > & {
    environment?: ChatDetailsEnvironmentData;
    outputs?: ChatDetailsOutputs;
    /** Stable per native resource identity; acquire only while Details is presented. */
    retainOutputs?: () => (() => void) | undefined;
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
