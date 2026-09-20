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
