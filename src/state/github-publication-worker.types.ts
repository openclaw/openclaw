export type PersonalPublicationSelector =
  | { requestId: string }
  | { sessionId: string; idempotencyKey: string }
  | { sessionKey: string; agentId: string };
