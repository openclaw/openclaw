import type { ExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import type { GatewayBroadcastFn } from "./server-broadcast.js";

// AGENT_BOT_COMPAT: exposes exec approval state to control-plane HTTP handlers.

type ExecApprovalContext = {
  manager: ExecApprovalManager;
  forwarder?: ExecApprovalForwarder | null;
  broadcast?: GatewayBroadcastFn | null;
};

let globalExecApprovalContext: ExecApprovalContext | null = null;

export function setGlobalExecApprovalContext(ctx: ExecApprovalContext): void {
  globalExecApprovalContext = {
    manager: ctx.manager,
    forwarder: ctx.forwarder ?? null,
    broadcast: ctx.broadcast ?? null,
  };
}

export function getGlobalExecApprovalManager(): ExecApprovalManager | null {
  return globalExecApprovalContext?.manager ?? null;
}

export function getGlobalExecApprovalForwarder(): ExecApprovalForwarder | null {
  return globalExecApprovalContext?.forwarder ?? null;
}

export function getGlobalExecApprovalBroadcast(): GatewayBroadcastFn | null {
  return globalExecApprovalContext?.broadcast ?? null;
}
