import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import type { ChatSessionProgressProps } from "./chat-composer-types.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

type ChatDetailsWorkspace = { root: string | null; label: string | null; branch?: string };

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
  > & {
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
