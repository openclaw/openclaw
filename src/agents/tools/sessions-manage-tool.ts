import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway as defaultCallGateway } from "../../gateway/call.js";
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
  instructions: Type.Optional(Type.String()),
});

export function createSessionsManageTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: typeof defaultCallGateway;
}): AnyAgentTool {
  const callGateway = opts?.callGateway ?? defaultCallGateway;
  return {
    label: "Session Manage",
    name: "sessions_manage",
    description:
      "Compact or reset a session by key. Use action 'compact' for LLM-based semantic " +
      "compaction (summarizes conversation into Goal/Progress/Decisions/Next Steps) or " +
      "'reset' to clear the session and start fresh. Self-session operations are deferred " +
      "until the current turn ends. Optional 'instructions' guides the compaction focus.",
    parameters: SessionsManageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKeyParam = readStringParam(params, "sessionKey", { required: true });
      const action = readStringParam(params, "action", { required: true });
      const instructions = readStringParam(params, "instructions");

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
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "manage",
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
            ok?: boolean;
            status?: string;
            compacted?: boolean;
            tokensBefore?: number;
            tokensAfter?: number;
          }>({
            method: "sessions.compactSemantic",
            params: {
              key: resolvedKey,
              instructions,
              deferred: true,
            },
          });
          if (result?.status === "scheduled") {
            return jsonResult({
              status: "scheduled",
              action,
              sessionKey: displayKey,
              message:
                "Compaction will run after this turn ends. Finish your current work and produce a final response to trigger it.",
            });
          }
          return jsonResult({
            status: "ok",
            action,
            sessionKey: displayKey,
            compacted: result?.compacted === true,
            ...(result?.tokensBefore != null ? { tokensBefore: result.tokensBefore } : {}),
            ...(result?.tokensAfter != null ? { tokensAfter: result.tokensAfter } : {}),
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
          status?: string;
          key?: string;
          entry?: unknown;
        }>({
          method: "sessions.reset",
          params: {
            key: resolvedKey,
            deferred: true,
          },
        });
        if (result?.status === "scheduled") {
          return jsonResult({
            status: "scheduled",
            action,
            sessionKey: displayKey,
            message:
              "Reset will run after this turn ends. Finish your current work and produce a final response to trigger it.",
          });
        }
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
