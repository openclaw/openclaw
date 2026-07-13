// Operator terminal gateway methods: open a PTY shell bound to the caller's
// connection, then stream input/resize/close over the same WebSocket. All
// methods require admin scope (enforced by the descriptor table); this module
// re-checks that the feature is enabled and that isolation permits a host shell.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTerminalAttachParams,
  validateTerminalCloseParams,
  validateTerminalInputParams,
  validateTerminalOpenParams,
  validateTerminalResizeParams,
  validateTerminalTextParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { renderTerminalBufferText } from "../terminal/buffer-text.js";
import { buildTerminalEnv } from "../terminal/launch.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

function invalid(respond: GatewayRequestHandlerOptions["respond"], detail: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, detail));
}

function requireConnId(opts: GatewayRequestHandlerOptions): string | null {
  const connId = opts.client?.connId;
  if (!connId) {
    invalid(opts.respond, "terminal requires an authenticated connection");
    return null;
  }
  return connId;
}

function terminalEnabled(context: GatewayRequestHandlerOptions["context"]): boolean {
  return context.isTerminalEnabled();
}

/** Handlers for the operator terminal method family. */
export const terminalHandlers: GatewayRequestHandlers = {
  "terminal.open": async (opts) => {
    const { params, respond, context } = opts;
    if (!validateTerminalOpenParams(params)) {
      invalid(
        respond,
        `invalid terminal.open params: ${formatValidationErrors(validateTerminalOpenParams.errors)}`,
      );
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const manager = context.terminalSessions;
    if (!manager) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "terminal is not available"));
      return;
    }
    const p = params as { agentId?: string; cols: number; rows: number };
    const launch = context.resolveTerminalLaunchPolicy(p.agentId);
    if (!launch.ok) {
      if (launch.block.kind === "disabled") {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "terminal is disabled"));
        return;
      }
      if (launch.block.kind === "unknown-agent") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent "${launch.block.agentId}"`),
        );
        return;
      }
      // Fail closed: a sandboxed agent must never receive a host shell.
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `terminal unavailable: agent "${launch.block.agentId}" runs in a sandbox (mode "${launch.block.mode}"); in-sandbox terminals are not supported yet`,
        ),
      );
      return;
    }

    const outcome = await manager.open({
      connId,
      agentId: launch.plan.agentId,
      cwd: launch.plan.cwd,
      shell: launch.plan.shell,
      args: launch.plan.args,
      cols: p.cols,
      rows: p.rows,
      env: buildTerminalEnv(process.env),
    });
    if (!outcome.ok) {
      const code = outcome.code === "limit" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
      respond(false, undefined, errorShape(code, outcome.message));
      return;
    }
    context.logGateway.info(
      `terminal opened session=${outcome.sessionId} agent=${outcome.agentId} conn=${connId} shell=${outcome.shell}`,
    );
    respond(true, {
      sessionId: outcome.sessionId,
      agentId: outcome.agentId,
      shell: outcome.shell,
      cwd: outcome.cwd,
      confined: false,
    });
  },

  "terminal.input": async (opts) => {
    const { params, respond, context } = opts;
    if (!validateTerminalInputParams(params)) {
      invalid(
        respond,
        `invalid terminal.input params: ${formatValidationErrors(validateTerminalInputParams.errors)}`,
      );
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string; data: string };
    // Defense-in-depth for an RCE-class surface: disabling the terminal
    // restarts the gateway, but the runtime config snapshot flips first, so
    // re-checking here cuts keystrokes to live PTYs before the restart lands.
    if (!terminalEnabled(context)) {
      context.terminalSessions?.close(connId, p.sessionId);
      respond(true, { ok: false });
      return;
    }
    const ok = context.terminalSessions?.write(connId, p.sessionId, p.data) ?? false;
    respond(true, { ok });
  },

  "terminal.resize": async (opts) => {
    const { params, respond, context } = opts;
    if (!validateTerminalResizeParams(params)) {
      invalid(
        respond,
        `invalid terminal.resize params: ${formatValidationErrors(validateTerminalResizeParams.errors)}`,
      );
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string; cols: number; rows: number };
    if (!terminalEnabled(context)) {
      context.terminalSessions?.close(connId, p.sessionId);
      respond(true, { ok: false });
      return;
    }
    const ok = context.terminalSessions?.resize(connId, p.sessionId, p.cols, p.rows) ?? false;
    respond(true, { ok });
  },

  "terminal.close": async (opts) => {
    const { params, respond, context } = opts;
    if (!validateTerminalCloseParams(params)) {
      invalid(
        respond,
        `invalid terminal.close params: ${formatValidationErrors(validateTerminalCloseParams.errors)}`,
      );
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string };
    const ok = context.terminalSessions?.close(connId, p.sessionId) ?? false;
    respond(true, { ok });
  },

  "terminal.attach": async (opts) => {
    const { params, respond, context } = opts;
    if (!validateTerminalAttachParams(params)) {
      invalid(
        respond,
        `invalid terminal.attach params: ${formatValidationErrors(validateTerminalAttachParams.errors)}`,
      );
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string };
    // Same defense-in-depth as input/resize: the disable restart may still be
    // in flight, so refuse handing a live PTY stream to a new connection.
    if (!context.terminalSessions || !terminalEnabled(context)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "terminal is not available"));
      return;
    }
    const attached = context.terminalSessions.attach(connId, p.sessionId);
    if (!attached) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown terminal session "${p.sessionId}"`),
      );
      return;
    }
    context.logGateway.info(
      `terminal attached session=${attached.sessionId} agent=${attached.agentId} conn=${connId}`,
    );
    respond(true, {
      sessionId: attached.sessionId,
      agentId: attached.agentId,
      shell: attached.shell,
      cwd: attached.cwd,
      confined: false,
      buffer: attached.buffer,
    });
  },

  "terminal.list": async (opts) => {
    const { respond, context } = opts;
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    // An empty list (not an error) when the surface is off/unwired keeps the
    // reconnect flow simple: clients just fall back to opening fresh sessions.
    const sessions =
      context.terminalSessions && terminalEnabled(context)
        ? context.terminalSessions.list().map((session) => ({
            sessionId: session.sessionId,
            agentId: session.agentId,
            shell: session.shell,
            cwd: session.cwd,
            // Mirrors terminal.open: only unconfined host shells exist today.
            confined: false,
            attached: session.attached,
            createdAtMs: session.createdAtMs,
          }))
        : [];
    respond(true, { sessions });
  },

  "terminal.text": async (opts) => {
    const { params, respond, context } = opts;
    if (!validateTerminalTextParams(params)) {
      invalid(
        respond,
        `invalid terminal.text params: ${formatValidationErrors(validateTerminalTextParams.errors)}`,
      );
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string };
    if (!context.terminalSessions || !terminalEnabled(context)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "terminal is not available"));
      return;
    }
    const raw = context.terminalSessions.snapshot(p.sessionId);
    if (raw === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown terminal session "${p.sessionId}"`),
      );
      return;
    }
    respond(true, { text: renderTerminalBufferText(raw) });
  },
};
