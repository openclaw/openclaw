// Phase 9 Discord Surface Overhaul: agent-callable `acp_receipts` tool.
//
// Exposes the per-session delivery-receipt ring so an agent can observe its
// own delivery fate (delivered/suppressed + reason) without polling. Reuses
// the same visibility-guard pattern as `sessions_send` / `sessions_list` so
// cross-session reads honor the `tools.sessions.visibility` policy.

import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listReceiptsForSession,
  type DeliveryReceipt,
} from "../../infra/outbound/delivery-receipts.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const AcpReceiptsToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
});

export function createAcpReceiptsTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "ACP Receipts",
    name: "acp_receipts",
    description:
      "List recent delivery receipts (delivered/suppressed + reason) for a session. Defaults to the calling session.",
    parameters: AcpReceiptsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const effectiveSessionKey = sessionKeyParam ?? opts?.agentSessionKey ?? "";
      if (!effectiveSessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "sessionKey required (no caller-session fallback available)",
        });
      }

      const resolvedSession = await resolveSessionReference({
        sessionKey: effectiveSessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: effectiveSessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }

      const visibilityGuard = await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(visibleSession.key);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
          sessionKey: visibleSession.displayKey,
        });
      }

      const limit = readNumberParam(params, "limit", { integer: true });
      const receipts: DeliveryReceipt[] = listReceiptsForSession(
        visibleSession.key,
        typeof limit === "number" ? limit : undefined,
      );

      return jsonResult({
        status: "ok",
        sessionKey: visibleSession.displayKey,
        receipts,
      });
    },
  };
}
