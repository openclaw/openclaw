import { createSignal, lazy, Loading, Show } from "solid-js";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
} from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import type { GuestWelcomeHandle } from "../../app/guest-welcome-handle.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import type { ChatProviderReviewOwner } from "./chat-provider-review-controller.tsx";
import { renderGuestWelcomeStatus } from "./components/chat-guest-welcome.tsx";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import type { ChatRunError } from "./run-lifecycle.ts";
import type { ParticipantApprovalNotice } from "./session-approval-projection.ts";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../styles/chat/conversation-notices.css";

registerChatSessionEnglish();

const SessionApprovalNotice = lazy(() => import("./session-approval-notice.tsx"), {
  export: "SessionApprovalNotice",
});
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
  errorDetail?: unknown;
  onDismissError?: () => void;
};

export type ChatComposerNoticesProps = ChatPlacementStartupNoticeProps & {
  sessionKey?: string;
  presented?: boolean;
  connected?: boolean;
  messages: readonly unknown[];
  providerPolicyNotice?: ProviderPolicyNotice | null;
  participantApproval?: ParticipantApprovalNotice | null;
  // Resolve after the first pane frame prepares the Solid owner's permission facts.
  readProviderReview?: () => ChatProviderReviewOwner | undefined;
  nativeRecovery?: ChatNativeRecoveryNotice;
  runError?: ChatRunError | null;
  onRefresh?: () => void;
  onDismissWorkspaceConflict?: () => void;
  onDismissRunError?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

export type ChatNativeRecoveryNotice = { key: string; onResume?: () => Promise<void> };

function NativeRecoveryNotice(props: { onResume?: () => Promise<void> }) {
  const [pending, setPending] = createSignal(false);
  let resuming = false;
  const resume = async () => {
    if (resuming || !props.onResume) {
      return;
    }
    resuming = true;
    setPending(true);
    try {
      await props.onResume();
    } finally {
      resuming = false;
      setPending(false);
    }
  };
  return (
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--warn chat-native-recovery"
      role="status"
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <div class="chat-composer-neighbor-card__copy">
        <strong>{t("chat.nativeRecovery.title")}</strong>
        <span>{t("chat.nativeRecovery.body")}</span>
      </div>
      <Show when={props.onResume}>
        <button
          type="button"
          class="btn btn--sm"
          disabled={pending()}
          onClick={() => void resume()}
        >
          {t(pending() ? "chat.nativeRecovery.resuming" : "chat.nativeRecovery.resume")}
        </button>
      </Show>
    </div>
  );
}

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
      <Show when={props.nativeRecovery?.key} keyed>
        <NativeRecoveryNotice onResume={props.nativeRecovery?.onResume} />
      </Show>
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
      <Show when={props.participantApproval}>
        {(approval) => (
          <ChatLazyBoundary>
            <SessionApprovalNotice approval={approval()} />
          </ChatLazyBoundary>
        )}
      </Show>
    </>
  );
}
