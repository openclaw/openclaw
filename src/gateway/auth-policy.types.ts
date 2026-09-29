export type GatewayAuthPolicy = Readonly<{
  generation: string;
  /** Only operator WebSocket admission consumes identity grants. */
  verifiedIdentity?: string;
}>;
