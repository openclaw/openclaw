import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
import type { ApplicationChatSubmissions } from "../../app/chat-submissions.ts";
import type { CommandClientPresentationAction } from "../../app/command-client-presentation.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ChatAttachment, ChatGoalDraftMode } from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { SessionRefreshTarget } from "../../lib/sessions/index.ts";
import type { ChatCommandHost } from "./chat-commands.ts";
import type { ChatSendTimingEntry } from "./chat-send-ack.ts";
import type { QueuedMessageEdit } from "./queued-message-edit.ts";
import type { ToolStreamHost } from "./tool-stream-contract.ts";

export type ChatComposerRecoveryOwner = {
  resolveOwner: () => ChatHost | undefined;
  retainedAttachmentIds: (attachments: readonly ChatAttachment[]) => ReadonlySet<string>;
};

export type ChatHost = ToolStreamHost &
  ChatCommandHost & {
    chatSubmissions: ApplicationChatSubmissions;
    canRestoreComposer?: () => boolean;
    /** Captures this composer's identity while its presentation may hand ownership off. */
    captureComposerRecoveryOwner?: () => ChatComposerRecoveryOwner | undefined;
    /** Captured once at submit; queued delivery never re-reads the current page. */
    getWorkContext?: () => ChatWorkContext | undefined;
    chatGoalDraftMode?: ChatGoalDraftMode | null;
    selectedChatSessionIncognito?: boolean;
    /** Pane-local row draft while a queued message remains held in the outbox. */
    chatQueuedEdit?: QueuedMessageEdit | null;
    chatSendingScopeKey?: string | null;
    refreshSessionsAfterChat: Map<string, SessionRefreshTarget>;
    chatSubmitGuards?: Set<string>;
    chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
    eventLogBuffer?: unknown[];
    settings: Pick<UiSettings, "lastActiveSessionKey"> & Partial<UiSettings>;
    applySettings: (patch: Partial<UiSettings>) => void;
    /** Prepared from the browser override and current Gateway effective queue mode. */
    chatFollowUpMode?: ControlUiFollowUpMode;
    /** Selected message to reply to (right-click / keyboard shortcut). */
    chatReplyTarget?: {
      messageId: string;
      text: string;
      senderLabel?: string | null;
      sourceMessageId?: string | null;
    } | null;
    /** Control UI route for /btw and /side; server/TUI command handling remains unchanged. */
    openSessionCompanion?: (question: string) => Promise<void> | void;
    /** Handles a recognized catalog action only when this client can complete it. */
    dispatchClientPresentation?: (action: CommandClientPresentationAction) => Promise<boolean>;
  };
