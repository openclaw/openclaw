/** Presentation destination captured from the requesting Control UI, never model arguments. */
export type GatewayUiCommandTarget = Readonly<{
  connId: string;
  profileId?: string;
}>;
