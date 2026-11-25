import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";

export type CronCreatorAuthorityGrant = Readonly<{
  runId: string;
  token: string;
}>;

/** Private native sender fact shared by creator grants and the stored job envelope. */
export type CronAuthenticatedChannelRequester = {
  version: 1;
  channel: string;
  accountId: string;
  senderId: string;
};

/** Admission fact, checked once at run start; an authorized yield can transfer it. */
export type CronManagementEntitlement = Readonly<{
  source: "control-ui-admin" | "native-app-admin" | "channel-owner";
}>;

export type CronCreatorAuthorityRunScope = {
  readonly runId: string;
  readonly callerOrigin: CronScheduledToolCallerOrigin;
  readonly signal: AbortSignal;
  readonly grantTokens: Set<string>;
  readonly managementEntitlement?: CronManagementEntitlement;
  /** Separately admitted channel-owner identity, not implied by automation management rights. */
  readonly requesterOwner?: Readonly<{
    senderId?: string;
    channel?: string;
    accountId?: string;
  }>;
  /** Fresh admission only; never transferred with a management continuation. */
  readonly callerScopedCreation?: true;
  /** @deprecated Read managementEntitlement. Harness source compatibility lasts through 2026-10-12. */
  readonly controlUiAdmin?: true;
  readonly isCurrent?: () => boolean;
  active: boolean;
  abort: () => void;
};

/** Opaque in-process capability minted only by an admitted exact run. */
export type CronCreatorAuthorityCapability = CronCreatorAuthorityRunScope;
