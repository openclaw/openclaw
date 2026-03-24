import { formatCliCommand } from "../cli/command-format.js";
import type { PortListener, PortListenerKind, PortUsage } from "./ports-types.js";

export function classifyPortListener(listener: PortListener, port: number): PortListenerKind {
  const raw = `${listener.commandLine ?? ""} ${listener.command ?? ""}`.trim().toLowerCase();
  if (raw.includes("openclaw")) {
    return "gateway";
  }
  if (raw.includes("ssh")) {
    const portToken = String(port);
    const tunnelPattern = new RegExp(
      `-(l|r)\\s*${portToken}\\b|-(l|r)${portToken}\\b|:${portToken}\\b`,
    );
    if (!raw || tunnelPattern.test(raw)) {
      return "ssh";
    }
    return "ssh";
  }
  return "unknown";
}

function isLoopbackAddress(address: string): boolean {
  // Check if address is loopback (127.0.0.1 or ::1 or localhost variants)
  return (
    address.includes("127.0.0.1") ||
    address.includes("::1") ||
    address.includes("[::1]") ||
    address.startsWith("localhost:")
  );
}

function isDualStackLoopback(listeners: PortListener[]): boolean {
  // Check if all listeners are from the same PID on loopback addresses
  if (listeners.length === 0) {
    return false;
  }

  const pids = new Set(listeners.map((l) => l.pid).filter((pid) => pid !== undefined));
  const allLoopback = listeners.every((l) => l.address && isLoopbackAddress(l.address));

  // Dual-stack loopback: single PID, all loopback addresses
  return pids.size === 1 && allLoopback;
}

export function buildPortHints(listeners: PortListener[], port: number): string[] {
  if (listeners.length === 0) {
    return [];
  }
  const kinds = new Set(listeners.map((listener) => classifyPortListener(listener, port)));
  const hints: string[] = [];

  // Check if this is a dual-stack loopback listener (IPv4 + IPv6 from same PID)
  const dualStackLoopback = isDualStackLoopback(listeners);

  if (kinds.has("gateway")) {
    hints.push(
      `Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`,
    );
  }
  if (kinds.has("ssh")) {
    hints.push(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
  }
  if (kinds.has("unknown")) {
    hints.push("Another process is listening on this port.");
  }

  // Only warn about multiple listeners if they're NOT from the same PID on loopback
  if (listeners.length > 1 && !dualStackLoopback) {
    hints.push(
      "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.",
    );
  }

  // Add informational note for dual-stack loopback (not a warning)
  if (dualStackLoopback && listeners.length > 1) {
    hints.push("(Dual-stack loopback listener detected on both IPv4 and IPv6)");
  }

  return hints;
}

export function formatPortListener(listener: PortListener): string {
  const pid = listener.pid ? `pid ${listener.pid}` : "pid ?";
  const user = listener.user ? ` ${listener.user}` : "";
  const command = listener.commandLine || listener.command || "unknown";
  const address = listener.address ? ` (${listener.address})` : "";
  return `${pid}${user}: ${command}${address}`;
}

export function formatPortDiagnostics(diagnostics: PortUsage): string[] {
  if (diagnostics.status !== "busy") {
    return [`Port ${diagnostics.port} is free.`];
  }
  const lines = [`Port ${diagnostics.port} is already in use.`];
  for (const listener of diagnostics.listeners) {
    lines.push(`- ${formatPortListener(listener)}`);
  }
  for (const hint of diagnostics.hints) {
    lines.push(`- ${hint}`);
  }
  return lines;
}
