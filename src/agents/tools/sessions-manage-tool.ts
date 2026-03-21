import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SESSIONS_MANAGE_ACTIONS = ["compact", "reset"] as const;

const SessionsManageToolSchema = Type.Object({
  sessionKey: Type.String(),
  action: stringEnum(SESSIONS_MANAGE_ACTIONS),
});

export function createSessionsManageTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Session Manage",
    name: "sessions_manage",
    description:
      "Compact or reset a session by key. Use action 'compact' to compress context or 'reset' to start fresh.",
    parameters: SessionsManageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKeyParam = readStringParam(params, "sessionKey", { required: true });
      const action = readStringParam(params, "action", { required: true });

      if (!SESSIONS_MANAGE_ACTIONS.includes(action as (typeof SESSIONS_MANAGE_ACTIONS)[number])) {
        return jsonResult({ status: "error", error: "action must be 'compact' or 'reset'" });
      }

      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      // Resolve and validate the target session, same pattern as sessions_send.
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }

      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }

      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;

      // Enforce agent-to-agent and visibility policy.
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      // TODO: add "manage" to SessionAccessAction for accurate error messages
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }

      // Execute the requested action.
      if (action === "compact") {
        try {
          const result = await callGateway<{
            compacted?: boolean;
            reason?: string;
            kept?: number;
          }>({
            method: "sessions.compact",
            params: { key: resolvedKey },
          });
          return jsonResult({
            status: "ok",
            action,
            sessionKey: displayKey,
            compacted: result?.compacted === true,
            ...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
            ...(typeof result?.kept === "number" ? { kept: result.kept } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            action,
            sessionKey: displayKey,
            error: msg,
          });
        }
      }

      // action === "reset"
      try {
        const result = await callGateway<{
          ok?: boolean;
          key?: string;
          entry?: unknown;
        }>({
          method: "sessions.reset",
          params: { key: resolvedKey },
        });
        return jsonResult({
          status: "ok",
          action,
          sessionKey: displayKey,
          resetOk: result?.ok === true,
          ...(typeof result?.key === "string" ? { newKey: result.key } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          action,
          sessionKey: displayKey,
          error: msg,
        });
      }
    },
  };
}
