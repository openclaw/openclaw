export type ApnsEnvironment = "sandbox" | "production";

export type DirectApnsRegistration = {
  nodeId: string;
  transport: "direct";
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  updatedAtMs: number;
};

export type RelayApnsRegistration = {
  nodeId: string;
  transport: "relay";
  relayHandle: string;
  sendGrant: string;
  installationId: string;
  topic: string;
  environment: ApnsEnvironment;
  distribution: "official";
  updatedAtMs: number;
  relayOrigin?: string;
  tokenDebugSuffix?: string;
};

/** Stored APNs registration for either direct device tokens or official relay handles. */
export type ApnsRegistration = DirectApnsRegistration | RelayApnsRegistration;
