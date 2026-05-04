export class TerminalChannelError extends Error {
  readonly terminal = true as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalChannelError";
  }
}

export function isTerminalChannelError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { terminal?: unknown }).terminal === true,
  );
}
