import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import type { RetainedNewSessionDraft } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";

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
  /** Text-only launchers keep a rejected first prompt visible beside its created destination. */
  retainRejectedPrompt?: true;
};
