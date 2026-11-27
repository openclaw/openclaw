import type { TurnGrant } from "../../agents/admitted-run-operator-authority.types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { CronCreatorAuthorityCapability } from "../cron-creator-authority-grant.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendExternalAdmissionParams = {
  runId: string;
  sessionKey: string;
  spawnedBy?: string;
  isUncontrolledDashboardChild?: boolean;
  client: GatewayRequestHandlerOptions["client"];
  inputProvenance?: InputProvenance;
  grant?: TurnGrant;
  hasExplicitOrigin: boolean;
  hasRestoredCronContinuation: boolean;
  isIncognitoEntry: boolean;
  isSystemGenerated: boolean;
  turnKind: "btw" | "main";
};

export type ChatSendExternalAuthorityAdmission = {
  resolve(params: ChatSendExternalAdmissionParams): CronCreatorAuthorityCapability | undefined;
  allowsDashboardReads(params: ChatSendExternalAdmissionParams): boolean;
  run<T>(capability: CronCreatorAuthorityCapability, run: () => T, signal?: AbortSignal): T;
};
