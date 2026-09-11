import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsStatusResult,
  validateSessionsDescribeParams,
  validateSessionsStatusParams,
  validateSessionsStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
} from "../session-sharing.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import {
  projectGatewaySessionActiveRun,
  projectGatewaySessionRunState,
} from "../session-utils-display.js";
import { buildSessionListRowMetadataContext } from "../session-utils-projection.js";
import { createGatewaySessionEntryReader } from "../session-utils-store-lookup.js";
import { buildGatewaySessionRow } from "../session-utils.js";
import { readPreparedServerMethodModelCatalog } from "./optional-model-catalog.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { readSessionPlacementFields } from "./session-placement-read-projection.js";
import { loadSessionEntriesForTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function createRoleVisibilityFilter(
  client: Parameters<typeof hasOperatorBoundary>[0],
  cfg: Parameters<typeof hasOperatorBoundary>[1],
) {
  return hasOperatorBoundary(client, cfg)
    ? createSessionListEntryFilter({ client, cfg })
    : undefined;
}

export const sessionByKeyReadHandlers: GatewayRequestHandlers = {
  "sessions.status": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsStatusParams, "sessions.status", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    // Dispatch can await profile resolution and lazy loading. Keep the final read,
    // visibility decision, and projection synchronous against current ownership.
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { target, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    const observedAt = Date.now();
    const boundaryFilter = createRoleVisibilityFilter(client, cfg);
    if (
      !entry?.sessionId ||
      (params.sessionId !== undefined && params.sessionId !== entry.sessionId) ||
      boundaryFilter?.(target.canonicalKey, entry) === false ||
      authorizeIncognitoSessionTarget({
        client,
        sessionKey: target.canonicalKey,
        target: { ...target, entry, storeKey: target.canonicalKey },
      })
    ) {
      respond(true, { observedAt, session: null } satisfies SessionsStatusResult);
      return;
    }
    const active = resolveVisibleActiveSessionRunState({
      context,
      requestedKey: key,
      canonicalKey: target.canonicalKey,
      sessionId: entry.sessionId,
      agentId: target.agentId,
    });
    const { fields } = projectGatewaySessionRunState({
      key: target.canonicalKey,
      entry,
      now: observedAt,
    });
    const aggregate = projectGatewaySessionActiveRun(active, fields.status);
    // lastRunId is public terminal identity. Private lifecycle ids and aggregate
    // activity cannot identify the requested run, even when only one run is active.
    const matchedRun =
      params.expectedRunId !== undefined &&
      entry.lastRunId === params.expectedRunId &&
      (entry.status === "done" ||
        entry.status === "failed" ||
        entry.status === "killed" ||
        entry.status === "timeout")
        ? {
            runId: entry.lastRunId,
            status: entry.status,
            ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
          }
        : null;
    const result = {
      observedAt,
      session: {
        key: target.canonicalKey,
        agentId: target.agentId,
        sessionId: entry.sessionId,
        ...(aggregate.status !== undefined ? { status: aggregate.status } : {}),
        hasActiveRun: active.active,
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        matchedRun,
      },
    } satisfies SessionsStatusResult;
    // Stored identities are never truncated to fit the public bounded contract.
    if (!validateSessionsStatusResult(result)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Session status is unavailable; refresh the session selection.",
        ),
      );
      return;
    }
    respond(true, result);
  },
  "sessions.describe": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const catalogAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      key,
      params.agentId,
    );
    if (!catalogAgent.ok) {
      respond(false, undefined, catalogAgent.error);
      return;
    }
    const modelCatalog = await readPreparedServerMethodModelCatalog(context, {
      agentId: catalogAgent.agentId,
    });
    // Resolve the visible row after the catalog read yields to configuration or session changes.
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { target, storePath, store, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      includeStoreChildEntries: true,
      ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
    });
    const boundaryFilter = createRoleVisibilityFilter(client, cfg);
    if (!entry || boundaryFilter?.(target.canonicalKey, entry) === false) {
      respond(true, { session: null }, undefined);
      return;
    }
    const row = buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      modelSource: {
        entry,
        loadSessionEntry: createGatewaySessionEntryReader({
          cfg,
          agentId: target.agentId,
          store,
          readSource: target.readSource,
        }),
      },
      key: target.canonicalKey,
      entry,
      agentId: target.agentId,
      modelCatalog: new Map([[catalogAgent.agentId, modelCatalog]]),
      includeDerivedTitles: params.includeDerivedTitles,
      includeLastMessage: params.includeLastMessage,
      transcriptUsageMaxBytes: 64 * 1024,
      rowContext: buildSessionListRowMetadataContext({ now: Date.now() }),
      includeSwarmChildren: true,
    });
    Object.assign(row, readSessionPlacementFields(context, row.sessionId));
    respond(true, { session: row });
  },
  "sessions.get": async ({ params, respond, context, client }) => {
    // SAFETY: Gateway dispatch supplies object params; each optional field is narrowed before use.
    const p = params as {
      key?: unknown;
      sessionKey?: unknown;
      limit?: unknown;
      agentId?: unknown;
    };
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(
      cfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { target, storePath, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    const boundaryFilter = createRoleVisibilityFilter(client, cfg);
    if (!entry?.sessionId || boundaryFilter?.(target.canonicalKey, entry) === false) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const sessionId = entry.sessionId;
    const { messages } = await readRecentSessionMessagesWithStatsAsync(
      {
        agentId: target.agentId,
        sessionEntry: entry,
        sessionId,
        sessionKey: target.canonicalKey,
        storePath,
      },
      {
        maxMessages: limit,
        maxLines: limit * 20 + 20,
        allowResetArchiveFallback: true,
      },
    );
    const currentCfg = context.getRuntimeConfig();
    const currentRequestedAgent = resolveRequestedSessionAgentId(
      currentCfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    const current = currentRequestedAgent.ok
      ? loadSessionEntriesForTarget({
          key,
          cfg: currentCfg,
          agentId: currentRequestedAgent.agentId,
        })
      : null;
    const currentBoundaryFilter = createRoleVisibilityFilter(client, currentCfg);
    if (
      !current ||
      current.target.agentId !== target.agentId ||
      current.target.canonicalKey !== target.canonicalKey ||
      current.storePath !== storePath ||
      current.entry?.sessionId !== sessionId ||
      currentBoundaryFilter?.(current.target.canonicalKey, current.entry) === false
    ) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    respond(true, { messages }, undefined);
  },
};
