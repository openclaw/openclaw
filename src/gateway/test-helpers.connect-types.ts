export type ConnectReqClient = {
  id: string;
  displayName?: string;
  version: string;
  platform: string;
  mode: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  instanceId?: string;
};

export type ConnectReqDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce?: string;
};

export type ConnectReqOptions = {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
  skipDefaultAuth?: boolean;
  minProtocol?: number;
  maxProtocol?: number;
  client?: ConnectReqClient;
  role?: string;
  scopes?: string[];
  caps?: string[];
  includeSessionMessageBodies?: boolean;
  commands?: string[];
  permissions?: Record<string, boolean>;
  device?: ConnectReqDevice | null;
  deviceIdentityPath?: string;
  skipConnectChallengeNonce?: boolean;
  prePairDevice?: boolean;
  browserOrigin?: string;
  timeoutMs?: number;
  traceparent?: string;
};
