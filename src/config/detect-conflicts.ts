import { resolveSandboxConfigForAgent } from "../agents/sandbox.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawConfig } from "./config.js";
import type { GatewayBindMode } from "./types.gateway.js";

const log = createSubsystemLogger("config/conflicts");

export type ConflictResult = {
  level: "critical" | "warning" | "info";
  message: string;
};

function isSandboxActive(mode: string): boolean {
  return mode === "non-main" || mode === "all";
}

function isGatewayExposed(bind: GatewayBindMode): boolean {
  return bind === "lan" || bind === "custom" || bind === "auto" || bind === "tailnet";
}

export function detectConfigConflicts(config: OpenClawConfig): ConflictResult[] {
  const conflicts: ConflictResult[] = [];

  const sandboxMode = resolveSandboxConfigForAgent(config).mode;
  const sandboxActive = isSandboxActive(sandboxMode);
  const execAsk = config.tools?.exec?.ask ?? "on-miss";
  const execHost = config.tools?.exec?.host ?? "sandbox";
  const execSecurity = config.tools?.exec?.security ?? "deny";
  const elevatedEnabled = config.tools?.elevated?.enabled === true;
  const bind = config.gateway?.bind ?? "loopback";
  const authMode = config.gateway?.auth?.mode ?? "token";

  if (execAsk === "off" && sandboxActive) {
    conflicts.push({
      level: "warning",
      message:
        `tools.exec.ask is "off" but sandbox mode is "${sandboxMode}". ` +
        "Sandbox policy can still restrict non-main/all sessions and override expected exec behavior.",
    });
  }

  if (elevatedEnabled && sandboxActive) {
    conflicts.push({
      level: "warning",
      message:
        `tools.elevated.enabled is true while sandbox mode is "${sandboxMode}". ` +
        "Elevated workflows may still be constrained by sandbox boundaries.",
    });
  }

  if (execHost === "gateway" && sandboxActive) {
    conflicts.push({
      level: "warning",
      message:
        `tools.exec.host is "gateway" while sandbox mode is "${sandboxMode}". ` +
        "Mixed host/sandbox expectations can cause confusing runtime behavior across sessions.",
    });
  }

  if (isGatewayExposed(bind) && authMode === "none") {
    conflicts.push({
      level: "critical",
      message:
        `gateway.bind is "${bind}" while gateway.auth.mode is "none". ` +
        "This exposes the gateway without authentication; use token/password auth or bind to loopback.",
    });
  }

  if (
    sandboxMode === "all" &&
    execAsk === "always" &&
    execHost === "sandbox" &&
    execSecurity !== "full"
  ) {
    conflicts.push({
      level: "info",
      message:
        "Near-high-safety profile: sandbox=all, exec.ask=always, exec.host=sandbox. " +
        "Consider setting exec.security=full for maximum restriction.",
    });
  }

  return conflicts;
}

export function logConfigConflicts(config: OpenClawConfig): ConflictResult[] {
  const conflicts = detectConfigConflicts(config);
  for (const conflict of conflicts) {
    const text = `[CONFIG ${conflict.level.toUpperCase()}] ${conflict.message}`;
    if (conflict.level === "critical") {
      log.error(text);
    } else if (conflict.level === "warning") {
      log.warn(text);
    } else {
      log.info(text);
    }
  }
  return conflicts;
}
