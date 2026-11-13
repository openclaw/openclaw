import {
  ErrorCodes,
  errorShape,
  validateToolUsageImportParams,
  validateToolUsageResetParams,
  validateToolUsageStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  decayToolUsage,
  TOOL_USAGE_HALF_LIFE_MS,
  TOOL_USAGE_RETENTION_MS,
  type ToolUsageRow,
} from "../../agents/tool-usage.js";
import { resolveEffectiveToolInventory } from "../../agents/tools-effective-inventory.js";
import {
  importAgentToolUsage,
  readAgentToolUsageStatus,
  resetAgentToolUsage,
} from "../../config/sessions/tool-usage.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const unavailable = (error: unknown) =>
  errorShape(ErrorCodes.UNAVAILABLE, `Tool usage is unavailable: ${String(error)}`);

function topToolUsage(rows: readonly ToolUsageRow[], now: number, limit = 20) {
  return rows
    .map((row) => ({ ...row, score: decayToolUsage(row, now) }))
    .toSorted((a, b) => b.score - a.score || a.toolId.localeCompare(b.toolId))
    .slice(0, limit);
}

export const toolUsageHandlers: GatewayRequestHandlers = {
  "toolUsage.status": defineValidatedGatewayMethod(
    "toolUsage.status",
    validateToolUsageStatusParams,
    async (options) => {
      const { params, context, respond } = options;
      const selected = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId ?? "main",
        cfg: context.getRuntimeConfig(),
        respond,
      });
      if (!selected) {
        return;
      }
      const { agentId, cfg: config } = selected;
      const authority = readGatewayRequestMutationAuthority(options);
      if (params.sessionKey) {
        const owner = resolveRequestedSessionAgentId(config, params.sessionKey, agentId, "read");
        if (!owner.ok) {
          respond(false, undefined, owner.error);
          return;
        }
      }
      const now = Date.now();
      const status = await readAgentToolUsageStatus({ agentId, config, now });
      const top = topToolUsage(status.rows, now, params.limit ?? 20);
      const frozenSnapshot = params.sessionKey
        ? await (
            await import("../../agents/session-tool-usage-snapshot.js")
          ).readSessionToolUsageRankingSnapshot({
            agentId,
            sessionKey: params.sessionKey,
            config,
            assertCurrent: authority.assertCurrent,
          })
        : undefined;
      authority.assertCurrent();
      respond(true, {
        agentId,
        enabled: config.agents?.defaults?.experimental?.usageRankedToolIndex === true,
        now,
        rowCount: status.rows.length,
        halfLifeDays: TOOL_USAGE_HALF_LIFE_MS / 86_400_000,
        retentionDays: TOOL_USAGE_RETENTION_MS / 86_400_000,
        lastImportAt: status.lastImportAt ?? null,
        top,
        ...(params.sessionKey ? { sessionKey: params.sessionKey, frozenSnapshot } : {}),
      });
    },
    unavailable,
  ),
  "toolUsage.import": defineValidatedGatewayMethod(
    "toolUsage.import",
    validateToolUsageImportParams,
    async (options) => {
      const { params, context, respond } = options;
      const selected = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId ?? "main",
        cfg: context.getRuntimeConfig(),
        respond,
      });
      if (!selected) {
        return;
      }
      const { agentId, cfg: config } = selected;
      const authority = readGatewayRequestMutationAuthority(options);
      const inventory = await resolveEffectiveToolInventory({
        cfg: config,
        agentId,
        agentRuntime: "openclaw",
      });
      const catalog = inventory.groups.flatMap((group) =>
        group.tools.map((tool) => ({
          id: `${tool.source === "mcp" ? "mcp" : "openclaw"}:${tool.pluginId || "core"}:${tool.id}`,
          name: tool.id,
        })),
      );
      authority.assertCurrent();
      const result = await importAgentToolUsage({
        agentId,
        config,
        catalog,
        sinceDays: params.sinceDays ?? 90,
        dryRun: params.dryRun ?? false,
        assertCurrent: authority.assertCurrent,
      });
      authority.assertCurrent();
      const { rows, ...summary } = result;
      respond(true, {
        agentId,
        ...summary,
        rowCount: rows.length,
        top: topToolUsage(rows, Date.now()),
      });
    },
    unavailable,
  ),
  "toolUsage.reset": defineValidatedGatewayMethod(
    "toolUsage.reset",
    validateToolUsageResetParams,
    async (options) => {
      const { params, context, respond } = options;
      const selected = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId ?? "main",
        cfg: context.getRuntimeConfig(),
        respond,
      });
      if (!selected) {
        return;
      }
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const result = await resetAgentToolUsage({
        agentId: selected.agentId,
        config: selected.cfg,
        assertCurrent: authority.assertCurrent,
      });
      authority.assertCurrent();
      respond(true, { agentId: selected.agentId, reset: true, ...result });
    },
    unavailable,
  ),
};
