import type { reserveReplyAdmissionTicket } from "../../auto-reply/reply/reply-admission-ticket.js";
import type { ReplyMessageInjectionAttempt } from "../../auto-reply/reply/reply-run-registry.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import type { RestartSafeChatTerminalState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendAttachments } from "./chat-send-attachments.js";
import type { ChatSendDiagnostics } from "./chat-send-diagnostics.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import type { ChatSendReplyContextFields } from "./chat-send-reply-context.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import type { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type StartChatDispatchParams = {
  replyAdmissionTicket: ReturnType<typeof reserveReplyAdmissionTicket>;
  diagnostics: ChatSendDiagnostics;
  admissionStartedAt: number;
  admission: AdmittedChatSend;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  toolsAllow?: string[];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  prepareSkillLibraryAuthoring: () => Promise<
    import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability | undefined
  >;
  cronCreatorAuthority: ReturnType<ChatSendExternalAuthorityAdmission["resolve"]>;
  assertDashboardReadCurrent?: () => void;
  externalAuthorityAdmission: ChatSendExternalAuthorityAdmission | undefined;
  injection: {
    beginCapturedMessageInjection: () => Promise<ReplyMessageInjectionAttempt | undefined>;
    messageInjectionAttempt: ReplyMessageInjectionAttempt | undefined;
    preAckReplyContextPromise: Promise<ChatSendReplyContextFields> | undefined;
    replyContextFieldsPromise: Promise<ChatSendReplyContextFields> | undefined;
  };
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  terminalizeRestartSafeAdmission: (
    terminalState: RestartSafeChatTerminalState,
  ) => Promise<boolean>;
  timing: {
    chatSendAckedAtMs: number;
    chatSendTiming: ChatRunTiming | undefined;
  };
  turn: Awaited<ReturnType<typeof prepareChatSendUserTurn>>;
  userTurn: ReturnType<typeof createGatewayChatUserTurnController>;
};
