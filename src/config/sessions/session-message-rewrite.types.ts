export type SessionMessageRewriteResult = {
  generation: string;
  messageId: string;
  message: unknown;
  unchanged?: true;
};
