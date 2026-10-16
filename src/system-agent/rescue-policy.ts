import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecModePolicy } from "../infra/exec-approvals.js";

/**
 * Rescue intentionally opens only for owner-controlled, non-sandboxed YOLO host
 * posture because remote commands can write local state.
 */
type SystemAgentRescueDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "disabled" | "sandbox-active" | "not-owner" | "not-direct-message";
      message: string;
    };

type SystemAgentRescuePolicyInput = {
  cfg: OpenClawConfig;
  agentId?: string;
  senderIsOwner: boolean;
  isDirectMessage: boolean;
};

export function resolveSystemAgentRescuePolicy(
  input: SystemAgentRescuePolicyInput,
): SystemAgentRescueDecision {
  const agent = input.agentId ? resolveAgentEntry(input.cfg, input.agentId) : undefined;
  const sandboxMode = agent?.sandbox?.mode ?? input.cfg.agents?.defaults?.sandbox?.mode ?? "off";
  if (sandboxMode !== "off") {
    return {
      allowed: false,
      reason: "sandbox-active",
      message:
        "OpenClaw rescue is blocked because OpenClaw sandboxing is active. Fix the install locally or disable sandboxing before using remote rescue.",
    };
  }
  const globalExec = input.cfg.tools?.exec;
  const inherited = resolveExecModePolicy({
    mode: globalExec?.mode,
    security: globalExec?.security ?? "full",
    ask: globalExec?.ask ?? "off",
  });
  const scopedExec = agent?.tools?.exec;
  const effective = resolveExecModePolicy({
    mode: scopedExec?.mode,
    security: scopedExec?.security ?? inherited.security,
    ask: scopedExec?.ask ?? inherited.ask,
  });
  if (effective.mode !== "full") {
    return {
      allowed: false,
      reason: "disabled",
      message: "OpenClaw rescue requires YOLO host posture with sandboxing off.",
    };
  }
  if (!input.senderIsOwner) {
    return {
      allowed: false,
      reason: "not-owner",
      message: "OpenClaw rescue only accepts commands from an OpenClaw owner.",
    };
  }
  if (!input.isDirectMessage) {
    return {
      allowed: false,
      reason: "not-direct-message",
      message: "OpenClaw rescue is restricted to owner DMs by default.",
    };
  }
  return { allowed: true };
}
