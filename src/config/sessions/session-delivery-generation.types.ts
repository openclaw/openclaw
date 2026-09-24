export type SessionDeliveryGeneration = Readonly<{
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
}>;
