/** Internal creation intent; the Gateway binds the public key to its authenticated namespace. */
export type SessionCreationOperation = {
  digest: string;
  fingerprint: string;
  authorization: { role: string | null; scopes: readonly string[] };
};

export type SessionCreationReceipt = {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  fingerprint: string;
  authorization: SessionCreationOperation["authorization"];
  expiresAt: number;
};
