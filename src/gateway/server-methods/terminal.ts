// Operator terminal gateway methods: open a PTY shell bound to the caller's
// connection, then stream input/resize/close over the same WebSocket. All
// methods require admin scope (enforced by the descriptor table); this module
// re-checks that the feature is enabled and that isolation permits a host shell.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTerminalCloseParams,
  validateTerminalInputParams,
  validateTerminalOpenParams,
  validateTerminalResizeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildTerminalEnv, resolveTerminalLaunch } from "../terminal/launch.js";
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
  return context.getRuntimeConfig().gateway?.terminal?.enabled ?? true;
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
    const cfg = context.getRuntimeConfig();
    const terminalCfg = cfg.gateway?.terminal;
    const enabled = terminalCfg?.enabled ?? true;
    const p = params as { agentId?: string; cols: number; rows: number };

    const launch = resolveTerminalLaunch({
      config: cfg,
      enabled,
      agentId: p.agentId,
      configuredShell: terminalCfg?.shell,
    });
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
};
