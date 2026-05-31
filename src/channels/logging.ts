export type LogFn = (message: string) => void;

/** Emits a stable one-line inbound drop log shared by channel plugins. */
export function logInboundDrop(params: {
  log: LogFn;
  channel: string;
  reason: string;
  target?: string;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel}: drop ${params.reason}${target}`);
}

/** Emits a stable one-line typing lifecycle failure log shared by channel plugins. */
export function logTypingFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  action?: "start" | "stop";
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  const action = params.action ? ` action=${params.action}` : "";
  params.log(`${params.channel} typing${action} failed${target}: ${String(params.error)}`);
}

/** Emits a stable one-line acknowledgement cleanup failure log shared by channel plugins. */
export function logAckFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel} ack cleanup failed${target}: ${String(params.error)}`);
}
