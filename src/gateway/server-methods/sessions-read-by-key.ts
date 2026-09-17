import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateSessionsDescribeParams } from "../../../packages/gateway-protocol/src/index.js";
import { prepareSubagentSessionListReadIndex } from "../../agents/subagents/registry/subagent-registry-read.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { withSessionProjectionWorkBudget } from "../session-projection-work.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { createSessionListEntryFilter, prepareSessionSharing } from "../session-sharing.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import { buildSessionListRowMetadataContext } from "../session-utils-projection.js";
import {
  readSessionRowInputs,
  materializeSessionRow,
  presentSessionRow,
} from "../session-utils-row.js";
import { createGatewaySessionEntryReader } from "../session-utils-store-lookup.js";
import { readPreparedServerMethodModelCatalog } from "./optional-model-catalog.js";
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
    const readVisibleSession = (includeStoreChildEntries: boolean) => {
      const cfg = context.getRuntimeConfig();
      const requestedAgent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return null;
      }
      const { target, storePath, store, entry } = loadSessionEntriesForTarget({
        key,
        cfg,
        includeStoreChildEntries,
        ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
      });
      const sharing = prepareSessionSharing({ client, cfg });
      const boundaryFilter = hasOperatorBoundary(client, cfg) ? sharing.entryFilter : undefined;
      if (!entry || boundaryFilter?.(target.canonicalKey, entry) === false) {
        respond(true, { session: null }, undefined);
        return null;
      }
      return { cfg, target, storePath, store, entry, sharing };
    };
    if (!readVisibleSession(false)) {
      return;
    }
    const stateContext = captureOpenClawStateWorkerContext();
    const assertCurrent = () => {
      stateContext.maintenanceScope?.assertAdmission();
      stateContext.admission.assertCurrent();
    };
    return withSessionProjectionWorkBudget(async (budget) => {
      const indexNow = Date.now();
      const work = await prepareSubagentSessionListReadIndex(
        indexNow,
        stateContext,
        budget.shouldYield,
        budget.yieldIfNeeded,
      );
      budget.resumeAfterAwait();
      let step: ReturnType<typeof work.next>;
      do {
        const pause = budget.yieldIfNeeded();
        if (pause) {
          await pause;
        }
        assertCurrent();
        step = work.next();
      } while (!step.done);
      const pause = budget.yieldIfNeeded();
      if (pause) {
        await pause;
      }
      assertCurrent();
      const placementTarget = readVisibleSession(false);
      if (!placementTarget) {
        return;
      }
      const placementFields = await readSessionPlacementFields(
        context,
        placementTarget.entry.sessionId,
      );
      assertCurrent();
      // Recheck visibility and lifecycle after the placement snapshot yields.
      const current = readVisibleSession(true);
      if (!current) {
        return;
      }
      if (
        current.entry.sessionId !== placementTarget.entry.sessionId ||
        current.entry.lifecycleRevision !== placementTarget.entry.lifecycleRevision
      ) {
        respond(true, { session: null });
        return;
      }
      const { cfg, target, storePath, store, entry, sharing } = current;
      const now = Date.now();
      const { inputs, presentation } = readSessionRowInputs({
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
        now,
        modelCatalog: new Map([[catalogAgent.agentId, modelCatalog]]),
        includeDerivedTitles: params.includeDerivedTitles,
        includeLastMessage: params.includeLastMessage,
        transcriptUsageMaxBytes: 64 * 1024,
        rowContext: buildSessionListRowMetadataContext({
          now,
          subagentRuns: step.value.atTime(now),
        }),
        includeSwarmChildren: true,
      });
      const row = presentSessionRow(materializeSessionRow(inputs), presentation);
      Object.assign(row, {
        sharingRole: sharing.roleForTarget({
          agentId: target.agentId,
          canonicalKey: target.canonicalKey,
          entry,
          storeKey: target.canonicalKey,
          storeKeys: target.storeKeys,
          storePath,
        }),
        ...placementFields,
      });
      respond(true, { session: row });
    });
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
