import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import type { Signal, StoreSetter } from "solid-js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { ChatFollowUpMode, ChatSendShortcut } from "../../../app/settings.ts";
import type { SessionProgressCardRefreshAction } from "../../../components/session-progress-card.ts";
import type {
  ChatGoalAction,
  ChatGoalDraft,
  ChatGoalDraftMode,
  ChatGoalRecovery,
  ChatQueueItem,
  ChatQueueDisplayItem,
  ChatReplyTarget,
  HumanMention,
} from "../../../lib/chat/chat-types.ts";
import type { ComposerDraftSource } from "../../../lib/chat/composer-draft-changes.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import type { HumanMentionInput } from "../../../lib/chat/human-mentions.ts";
import type { PresentationBinding } from "../../../lib/presentation.ts";
import type { ProviderUsageDisplayProps } from "../../../lib/provider-quota-summary.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import type { PaneOutboxRecovery } from "../chat-outbox-recovery.tsx";
import type { ChatPaneModelControl } from "../chat-pane-model-control.tsx";
import type { ChatRealtimeView } from "../chat-realtime.ts";
import type { ChatRunStartupStatus } from "../chat-run-startup.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { ComposerMicrophoneOwner } from "../composer-microphone-picker.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "../input-history.ts";
import type { ChatRunError, ChatRunUiStatus } from "../run-lifecycle.ts";
import type { FallbackStatus } from "../tool-stream-contract.ts";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ComposerEmojiMenu } from "./chat-composer-emoji.tsx";
import type {
  HumanMentionAccess,
  HumanMentionDirectory,
  HumanMentionMenu,
} from "./chat-composer-mention-menu.tsx";
import type { ChatComposerCapabilityMenuProps } from "./chat-composer-plus-menu.types.ts";
import type { SkillMenu } from "./chat-composer-skill-menu.tsx";
import type { SlashMenu } from "./chat-composer-slash-menu.tsx";
import type { ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

type ChatQueuedEditProps = {
  editingId: string | null;
  editingText?: string;
  editingMentions?: readonly HumanMention[];
  source?: ChatQueueItem;
  onEdit?: (id: string) => void;
  onEditChange?: (text: string, mentions?: readonly HumanMention[]) => void;
  onEditSubmit?: () => void;
  onCancel: () => void;
};

/** Destinations and owner facts not already carried by ChatProps. */
type ChatMobileActivities = {
  onOpenSubagents?: NonNullable<ChatActivityPillsProps["subagents"]>["onOpen"];
  goal?: Pick<
    NonNullable<ChatActivityPillsProps["goal"]>,
    "executionConfirmed" | "hidden" | "onOpen"
  >;
  onOpenProgress?: NonNullable<ChatActivityPillsProps["progress"]>["onOpen"];
  onOpenPullRequest?: NonNullable<ChatActivityPillsProps["pullRequests"]>["onOpen"];
  /** Eligibility is decided by the publication owner, including retained outcomes. */
  publication?: {
    eligible: boolean;
    onOpen: NonNullable<ChatActivityPillsProps["publication"]>["onOpen"];
  };
};

export type ChatComposerDisabledBanner = {
  kind: "above-composer" | "composer-replacement";
  presentation?: "compact" | "hidden";
  title?: string;
  text: string;
  tone?: "info" | "neutral";
  icon?: "warning" | "archive" | "eye";
  actionStyle?: "primary";
  busy?: boolean;
  busyLabel?: string;
  disabledReason?: string;
  /** Existing pane run action, relocated into the desktop subagent notice. */
  stop?: { onAbort: () => void };
} & ({ actionLabel: string; onAction: () => void } | { actionLabel?: never; onAction?: never });

export type ChatSessionProgressProps = {
  sessionKey: string;
  currentAgentId: string;
  progressCard?: ProgressCard | null;
  progressCardIdentity?: string;
  progressCardLifetime?: object;
  progressCardInitialLoading?: boolean;
  progressCardRefresh?: SessionProgressCardRefreshAction;
  gatewayScope?: object;
  runActive?: boolean;
  collapseTaskProgress?: boolean;
  onDismissProgressCard?: (card: ProgressCard) => void;
  onClearSavedProgressCard?: (card: ProgressCard) => void;
  messages: unknown[];
};

export type ChatComposerProps = ChatAttachmentControlsProps & {
  paneId: string;
  getTranscriptElement?: () => HTMLElement | null;
  getScrollToLatestElement?: () => HTMLButtonElement | null;
  onComposerShellRef?: (element: HTMLElement) => void | (() => void);
  onComposerFloatRef?: (element: HTMLElement) => void | (() => void);
  onActivityPillsLayout?: ChatActivityPillsProps["onLayout"];
  /** Native merged chrome, supplied by the pane owner; never inferred from pane width. */
  mobileComposer?: boolean;
  /** Observed keyboard visibility from the shell viewport owner, when available. */
  mobileKeyboardVisible?: boolean;
  /** Presentation fact only. The host owns dock suspension and viewport recovery. */
  onComposerEditingChange?: (editing: boolean) => void;
  mobileActivities?: ChatMobileActivities;
  /** Prepared by ChatComposerView from native facts and real destinations. */
  mobileActivityPills?: ChatActivityPillsProps;
  mobileApprovalContent?: JSX.Element;
  /** Provisional/deleted previews must not mount session-scoped extension controllers. */
  sessionAdmitted?: boolean;
  connected: boolean;
  offline?: boolean;
  canSend: boolean;
  canCompose?: boolean;
  modelRequiredReason?: string | null;
  submitDisabledReason?: string | null;
  submitPending?: boolean;
  disabledReason: string | null;
  disabledReasonTone?: "info" | "danger";
  disabledReasonBusy?: boolean;
  disabledBanner?: ChatComposerDisabledBanner;
  runError?: ChatRunError | null;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  startupStatus?: ChatRunStartupStatus | null;
  waitingApproval?: boolean;
  fallbackStatus?: FallbackStatus | null;
  progressCardVisibility?: PresentationBinding;
  readingHistory?: boolean;
  onProgressManipulate?: () => void;
  runId?: string | null;
  /** The pane scopes Gateway questions to this conversation's agent and session. */
  gatewayQuestionPrompts?: readonly QuestionPrompt[];
  stream: string | null;
  queue: ChatQueueItem[];
  draft: string;
  draftSource?: ComposerDraftSource;
  composerPredictions?: {
    enabled: boolean;
    active: boolean;
    gateway: Pick<ApplicationGateway, "subscribeEvents">;
  };
  mentions?: readonly HumanMention[];
  getMentions?: () => readonly HumanMention[];
  mentionDirectory?: HumanMentionDirectory;
  /** Register the mounted native composer operation; return its parent-owned release. */
  registerHumanMentionAccess?: (access: HumanMentionAccess) => () => void;
  mentionsUnsupported?: boolean;
  modelCatalog: readonly ModelCatalogEntry[];
  modelSwitching: boolean;
  sessions: SessionsListResult | null;
  /** The pane resolves aliases and agent ownership; absence must not reuse an unowned row. */
  selectedSession?: GatewaySessionRow;
  toolOverrides?: SessionToolOverrides;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
  providerUsage?: ProviderUsageDisplayProps;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  followUpMode?: ControlUiFollowUpMode;
  pendingAttachmentReads?: number;
  attachmentReadRevision?: number;
  getPendingAttachmentReads?: () => number;
  replyTarget?: ChatReplyTarget | null;
  gatewayClient?: GatewayBrowserClient | null;
  composerHoldToRecord?: boolean;
  realtimeTalkInputDeviceId?: string;
  onComposerHoldToRecordChange?: (enabled: boolean) => void;
  onOpenTalkSettings?: () => void;
  onOpenDictationSettings?: () => void;
  suggestionComposer?: boolean;
  onTypingChange?: (typing: boolean, preview?: string, cursor?: number) => void;
  composerControls?: Parameters<typeof ChatPaneModelControl>[0] & {
    component: typeof ChatPaneModelControl;
  };
  footerContent?: JSX.Element;
  composerRecovery?:
    | (Parameters<typeof PaneOutboxRecovery>[0] & {
        component: typeof PaneOutboxRecovery;
      })
    | null;
  notices?: JSX.Element;
  permissionPicker?: ChatPermissionPickerProps;
  onDraftChange: (next: string, mentions?: readonly HumanMention[]) => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSlashCommand?: (command: string) => void;
  onSend: (
    followUpModeOverride?: ChatFollowUpMode,
    submissionAction?: Event,
  ) => void | Promise<boolean | void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeCamera?: () => void;
  onSwitchRealtimeCamera?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onDismissRealtimeTalkInputNotice?: () => void;
  onUseSystemDefaultMicrophone?: () => Promise<void>;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueMove?: (id: string, targetId: string) => void;
  displayQueue?: ChatQueueDisplayItem[];
  queuedEdit?: ChatQueuedEditProps;
  onClearReply?: () => void;
  goalRecovery?: ChatGoalRecovery;
  onGoalAction?: (goalId: string, action: ChatGoalAction) => void;
  onGoalSubmit?: (draft: ChatGoalDraft, submissionAction?: Event) => Promise<boolean>;
  goalDraftMode?: ChatGoalDraftMode | null;
  onGoalDraftModeChange?: (mode: ChatGoalDraftMode | null) => void;
  currentSessionId?: string | null;
  onGatewayQuestionChange?: () => void;
  onGatewayQuestionSubmit?: (id: string, answers: Record<string, string[]>) => void | Promise<void>;
  onGatewayQuestionSkip?: (id: string) => void | Promise<void>;
} & ChatSessionProgressProps &
  Partial<ChatRealtimeView>;

type ScopedComposerDraft = {
  key: string;
  value: string;
};

export type ChatComposerState = {
  skillMenu: SkillMenu;
  slashMenu: SlashMenu;
  slashCommandDispatchConnected: boolean;
  goalPending: Signal<ChatGoalDraftMode | null>;
  composerComposing: boolean;
  editRevision: number;
  mentionMenu: HumanMentionMenu;
  emojiMenu: ComposerEmojiMenu;
  mentionInput?: HumanMentionInput;
  composerInputIntentKey: string | null;
  pendingClearedSubmittedDraft: ScopedComposerDraft | null;
  presentation: {
    dictationError: string | null;
    goalExpandedId: string | null;
  };
  updatePresentation: StoreSetter<ChatComposerState["presentation"]>;
  questionTakeoverActive: boolean;
  restoreComposerFocus: boolean;
  composerInput: HTMLElement | null;
  composerTextarea: HTMLTextAreaElement | null;
  microphonePicker: ComposerMicrophoneOwner | null;
  // Stable refs keep layout observers attached across frame updates.
  composerInputRef: ((element?: Element) => void) | null;
  textareaRef: ((element?: Element) => void) | null;
  dictation: ComposerDictationOwner | null;
  composerDraftScope: { key: string } | null;
  dictationSelection: { start: number; end: number; value: string } | null;
};
