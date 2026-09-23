/** Server-attested identity facts shared by RPC and transport client records. */
export type GatewayWsBrowserOrigin = {
  requestHost?: string;
  origin?: string;
  isLocalClient?: boolean;
};

export type PreparedSessionProfile = {
  profileId: string;
  aliases: ReadonlySet<string>;
  role: string | null;
};
