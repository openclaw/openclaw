export type CronCreatorAuthorityGrant = Readonly<{
  runId: string;
  token: string;
}>;

/** Admitted Gateway-wide automation management bound to one run's delegated authority. */
export type CronManagementGrantBinding = {
  managementOnly: boolean;
  mint: (method: string, signal?: AbortSignal) => CronCreatorAuthorityGrant | undefined;
};

/** Private native sender fact shared by creator grants and the stored job envelope. */
export type CronAuthenticatedChannelRequester = {
  version: 1;
  channel: string;
  accountId: string;
  senderId: string;
};
