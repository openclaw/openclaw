import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatPortDiagnostics } from "../../infra/ports-format.js";
import type { DaemonStatus } from "./status.gather.js";

export function renderPortDiagnosticsForCli({ port }: DaemonStatus, rpcOk?: boolean): string[] {
  if (!port || port.status === undefined || port.status === "free" || rpcOk === true) {
    return [];
  }
  return formatPortDiagnostics({
    port: port.port,
    status: port.status,
    listeners: port.listeners.map((listener) => ({
      ...listener,
      user: listener.user ? terminalText`${listener.user}` : listener.user,
      command: listener.command ? terminalText`${listener.command}` : listener.command,
      commandLine: listener.commandLine
        ? terminalText`${listener.commandLine}`
        : listener.commandLine,
      address: listener.address ? terminalText`${listener.address}` : listener.address,
    })),
    hints: port.hints.map((hint) => terminalText`${hint}`),
  });
}

export function resolvePortListeningAddresses(status: DaemonStatus): string[] {
  return Array.from(
    new Set(
      status.port?.listeners
        ?.map((l) => (l.address ? normalizeListenerAddress(l.address) : ""))
        .filter((v): v is string => Boolean(v)) ?? [],
    ),
  );
}

function normalizeListenerAddress(raw: string): string {
  return raw
    .trim()
    .replace(/^TCP\s+/i, "")
    .replace(/\s+\(LISTEN\)\s*$/i, "")
    .trim();
}
