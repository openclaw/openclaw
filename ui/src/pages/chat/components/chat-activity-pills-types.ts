import type { ProgressCard, SessionRunStatus } from "@openclaw/gateway-protocol";
import type { ControlUiAccessoryProps } from "../../../../../src/plugin-sdk/control-ui.js";
import type { SessionGoal } from "../../../api/types.ts";
import type { ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import type { SessionProgressCardRefreshState } from "../../../lib/session-progress-cards.ts";
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
    onOpen: OpenActivity;
  };
  progress?: {
    card: ProgressCard;
    sessionStatus?: SessionRunStatus;
    startedAt?: number;
    endedAt?: number;
    hasActiveRun: boolean;
    runtime?: import("../../../lib/session-progress-runtime.ts").SessionProgressCardRuntime;
    refresh?: SessionProgressCardRefreshState;
    onOpen: OpenActivity;
  };
  contributions?: {
    sessionKey: string;
    agentId?: string;
    facts?: ControlUiAccessoryProps["facts"];
    onOpenDetailsPage?: (
      pluginId: string,
      page: { id: string; title: string },
      source?: HTMLElement,
    ) => void;
  };
};
