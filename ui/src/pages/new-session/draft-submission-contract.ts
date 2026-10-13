import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import type { SessionCreateOutcome, SessionCreateParams } from "../../lib/sessions/create.ts";
import type { NewSessionCapabilityController } from "./capability-controller.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { RetainedNewSessionDraft } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";

export type RestoredDraftState = {
  message: string;
  mentions?: readonly HumanMention[];
  attachments: ChatAttachment[];
  visibility: NewSessionVisibility;
  toolOverrides?: NewSessionCapabilityController["toolOverrides"];
  permissionMode?: SessionCreateParams["permissionMode"];
};

export type DraftSubmissionSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected: boolean;
}>;

export type DraftSubmissionCallbacks = {
  retainForHandoff?: () => RetainedNewSessionDraft | undefined;
  takePreparedTitle?: () => string | undefined;
  onMessageChange?: (message: string) => void;
  requestUpdate: () => void;
  closeTransientUi: () => void;
  onAccepted?: (result: SessionCreateOutcome & { agentId: string }) => void;
  /** Launchers keep a rejected first prompt visible beside its created destination. */
  retainRejectedPrompt?: true;
};
