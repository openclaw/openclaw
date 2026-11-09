import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type { HumanSenderTurn } from "../../plugins/memory-human-sender-turn.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendExternalAdmissionParams = {
  runId: string;
  sessionKey: string;
  spawnedBy?: string;
  client: GatewayRequestHandlerOptions["client"];
  isCurrent?: () => boolean;
  inputProvenance?: InputProvenance;
  hasExplicitOrigin: boolean;
  hasRestoredCronContinuation: boolean;
  isIncognitoEntry: boolean;
  isReconnectResume: boolean;
  isSystemGenerated: boolean;
  turnKind: "btw" | "main";
  /** The request frame arrived on the operator's transport, not by in-process re-entry. */
  isExternalRequestFrame: boolean;
};

export type ChatSendExternalAuthorityAdmission = {
  resolve(params: ChatSendExternalAdmissionParams): CronCreatorAuthorityCapability | undefined;
  allowsDashboardReads(params: ChatSendExternalAdmissionParams): boolean;
  /** Attests a turn typed by the authenticated operator on this connection, owner or not. */
  issueHumanSenderTurn(params: ChatSendExternalAdmissionParams): HumanSenderTurn | undefined;
  run<T>(capability: CronCreatorAuthorityCapability, run: () => T, signal?: AbortSignal): T;
};
