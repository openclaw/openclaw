/** Public, secret-free request handle exposed to plugin-owned agent tools. */
export type BrokeredCredentialRequestHandle = {
  readonly id: string;
  readonly operationId: string;
  readonly expiresAtMs: number;
  execute(options?: { signal?: AbortSignal }): Promise<BrokeredCredentialJsonResponse>;
  revoke(): void;
  toJSON(): BrokeredCredentialRequestHandleSnapshot;
};

export type BrokeredCredentialRequestHandleSnapshot = {
  id: string;
  operationId: string;
  expiresAtMs: number;
  state: "pending" | "running" | "consumed" | "revoked";
};

export type BrokeredCredentialJsonResponse = {
  status: number;
  body: unknown;
};

/** Conversation-bound broker surface. Secret values never cross this boundary. */
export type OpenClawCredentialBroker = {
  isConfigured(operationId: string): boolean;
  createRequest(params: { operationId: string; body: unknown }): BrokeredCredentialRequestHandle;
};
