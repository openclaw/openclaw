export type LogFn = (message: string) => void;

/** Replace control characters (newlines, tabs, etc.) with spaces to prevent log injection. */
function sanitizeForLog(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip C0 controls + DEL to block log forging
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function logInboundDrop(params: {
  log: LogFn;
  channel: string;
  reason: string;
  target?: string;
}): void {
  const target = params.target ? ` target=${sanitizeForLog(params.target)}` : "";
  params.log(`${params.channel}: drop ${sanitizeForLog(params.reason)}${target}`);
}

export function logTypingFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  action?: "start" | "stop";
  error: unknown;
}): void {
  const target = params.target ? ` target=${sanitizeForLog(params.target)}` : "";
  const action = params.action ? ` action=${params.action}` : "";
  params.log(
    `${params.channel} typing${action} failed${target}: ${sanitizeForLog(String(params.error))}`,
  );
}

export function logAckFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  error: unknown;
}): void {
  const target = params.target ? ` target=${sanitizeForLog(params.target)}` : "";
  params.log(
    `${params.channel} ack cleanup failed${target}: ${sanitizeForLog(String(params.error))}`,
  );
}
