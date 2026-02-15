export type SendMessageRequest = {
  goalId: string;
  workdir: string;
  message: string;
  idempotencyKey: string;
  ackTimeoutMs: number;
  sessionName?: string;
};

export type SendMessageResult = {
  delivered: boolean;
  transport: "sdk" | "tmux";
  ackId?: string;
  outputText: string;
  reason?: string;
};

export interface LoopTransport {
  readonly kind: "sdk" | "tmux";
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
}
