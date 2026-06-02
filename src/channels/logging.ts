/** Minimal logger shape accepted by shared channel diagnostics helpers. */
export type LogFn = (message: string) => void;

/** Logs a dropped inbound message using the shared channel/target format. */
export function logInboundDrop(params: {
  /** Logger supplied by the channel runtime. */
  log: LogFn;
  /** Human-readable channel id included at the start of the line. */
  channel: string;
  /** Compact drop reason suitable for low-volume operator logs. */
  reason: string;
  /** Optional conversation or recipient target used to disambiguate drops. */
  target?: string;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel}: drop ${params.reason}${target}`);
}

/** Logs non-fatal typing feedback failures without interrupting reply delivery. */
export function logTypingFailure(params: {
  /** Logger supplied by the channel runtime. */
  log: LogFn;
  /** Human-readable channel id included at the start of the line. */
  channel: string;
  /** Optional conversation or recipient target used to disambiguate the failure. */
  target?: string;
  /** Typing action that failed when the channel reports start/stop separately. */
  action?: "start" | "stop";
  /** Original channel/API error to stringify for diagnostics. */
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  const action = params.action ? ` action=${params.action}` : "";
  params.log(`${params.channel} typing${action} failed${target}: ${String(params.error)}`);
}

/** Logs non-fatal acknowledgement cleanup failures after message handling continues. */
export function logAckFailure(params: {
  /** Logger supplied by the channel runtime. */
  log: LogFn;
  /** Human-readable channel id included at the start of the line. */
  channel: string;
  /** Optional conversation or recipient target used to disambiguate the failure. */
  target?: string;
  /** Original channel/API error to stringify for diagnostics. */
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel} ack cleanup failed${target}: ${String(params.error)}`);
}
