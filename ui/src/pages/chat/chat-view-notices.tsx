import { lazy, Loading, Show } from "solid-js";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
} from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import type { GuestWelcomeHandle } from "../../app/guest-welcome-handle.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import type { ChatProviderReviewOwner } from "./chat-provider-review-controller.tsx";
import { renderGuestWelcomeStatus } from "./components/chat-guest-welcome-status.tsx";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import type { ChatRunError } from "./run-lifecycle.ts";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../styles/chat/conversation-notices.css";

const ChatProviderReviewNotice = lazy(() => import("./chat-provider-review-controller.tsx"), {
  export: "ChatProviderReviewNotice",
});
const ChatTopbarNoticesContent = lazy(() => import("./chat-view-notices-content.tsx"), {
  export: "ChatTopbarNoticesContent",
});
const ChatComposerNoticesContent = lazy(() => import("./chat-view-notices-content.tsx"), {
  export: "ChatComposerNoticesContent",
});
const ChatPlacementStartupNotice = lazy(() => import("./chat-view-notices-content.tsx"), {
  export: "ChatPlacementStartupNotice",
});

export type ChatPlacementStartupNoticeProps = {
  placementStartup?: ApplicationPlacementStartupStatus | null;
  onRetrySessionPlacementStartup?: () => void;
  onDiscardSessionPlacementStartup?: () => void;
  /** App-wide guest welcome setup, shown beside the composer of the route's chat. */
  guestWelcome?: GuestWelcomeHandle;
};

export type ChatViewNoticesProps = {
  diskSpace?: SessionPlacementDiskSpace;
  workerRuntimeInstall?: SessionPlacementWorkerRuntimeInstall;
  error?: string | null;
  onDismissError?: () => void;
};

export type ChatComposerNoticesProps = ChatPlacementStartupNoticeProps & {
  sessionKey?: string;
  presented?: boolean;
  connected?: boolean;
  messages: readonly unknown[];
  providerPolicyNotice?: ProviderPolicyNotice | null;
  // Resolve after the first pane frame prepares the Solid owner's permission facts.
  readProviderReview?: () => ChatProviderReviewOwner | undefined;
  runError?: ChatRunError | null;
  onRefresh?: () => void;
  onDismissWorkspaceConflict?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

export function renderChatTopbarNotices(props: ChatViewNoticesProps) {
  return (
    <div class="chat-topbar-notices">
      <Show
        when={
          (props.diskSpace && props.diskSpace.status !== "ok") ||
          props.workerRuntimeInstall ||
          props.error
        }
      >
        <ChatLazyBoundary>
          <ChatTopbarNoticesContent {...props} />
        </ChatLazyBoundary>
      </Show>
    </div>
  );
}

export function renderChatComposerNotices(props: ChatComposerNoticesProps) {
  return (
    <>
      <Show when={props.readProviderReview?.()}>
        {(owner) => (
          <Loading>
            <ChatProviderReviewNotice owner={owner()} />
          </Loading>
        )}
      </Show>
      <Show when={props.runError || props.providerPolicyNotice || props.workspaceConflict}>
        <ChatLazyBoundary>
          <ChatComposerNoticesContent {...props} />
        </ChatLazyBoundary>
      </Show>
      <Show when={props.placementStartup}>
        <ChatLazyBoundary>
          <ChatPlacementStartupNotice
            status={props.placementStartup}
            messages={props.messages}
            connected={props.connected}
            onRetry={props.onRetrySessionPlacementStartup}
            onDiscard={props.onDiscardSessionPlacementStartup}
          />
        </ChatLazyBoundary>
      </Show>
      <Show when={props.guestWelcome} keyed>
        {(owner) => renderGuestWelcomeStatus(owner)}
      </Show>
    </>
  );
}
