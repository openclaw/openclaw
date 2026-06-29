// Accordion gateway method (Phase 2, 02-03): additive `accordion.toggle` lets the
// Control UI manually collapse/expand a topic box. It flips boxes.state only (manual
// override path) — turns are never mutated — mirroring the agent expand/collapse tools.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { setBoxStateManual } from "../../agents/memory/turns-store.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Gateway handler for manual topic collapse/expand from the Control UI. */
export const accordionHandlers: GatewayRequestHandlers = {
  "accordion.toggle": ({ params, respond, context }) => {
    const sessionKey = nonEmptyString(params.sessionKey);
    const boxId = nonEmptyString(params.boxId);
    const state =
      params.state === "collapsed" ? "collapsed" : params.state === "live" ? "live" : null;
    if (!sessionKey || !boxId || !state) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "accordion.toggle requires { sessionKey, boxId, state: 'live' | 'collapsed' }",
        ),
      );
      return;
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: context.getRuntimeConfig(),
      normalize: (rawAgentId) => (typeof rawAgentId === "string" ? rawAgentId.trim() : undefined),
    });
    if (!resolved) {
      return;
    }
    const changed = setBoxStateManual({ agentId: resolved.agentId, sessionKey, boxId, state });
    if (!changed) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown box "${boxId}" for session "${sessionKey}"`,
        ),
      );
      return;
    }
    respond(true, { ok: true, boxId, state }, undefined);
  },
};
