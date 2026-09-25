import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateSessionsDescribeParams } from "../../../packages/gateway-protocol/src/index.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
} from "../session-sharing.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import { createVisibleActiveSessionRunProjector } from "./session-active-runs.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionByKeyReadHandlers: GatewayRequestHandlers = {
  "sessions.describe": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const projection = getSessionRowProjection(context);
    if (!projection) {
      throw new Error("Session projection is unavailable before Gateway startup completes");
    }
    while (true) {
      const prepared = await projection.withPreparedExactRows(
        (cfg) => {
          const agent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
          const denied = authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: key,
            target: null,
          });
          return agent.ok && !denied ? [{ key, agentId: agent.agentId }] : [];
        },
        (read) => {
          sessionMutationAuthorization?.assertCurrent();
          const requestedAgent = resolveRequestedSessionAgentId(
            read.state.cfg,
            key,
            params.agentId,
          );
          if (!requestedAgent.ok) {
            respond(false, undefined, requestedAgent.error);
            return;
          }
          const query = { key, agentId: requestedAgent.agentId };
          const presentation = prepareProjectedSessionPresentation(
            read,
            client,
            Date.now(),
            createVisibleActiveSessionRunProjector(
              context,
              read.state.rowContext.projectedAgentRuns,
            ),
          );
          const denied = presentation.authorizeDescription(query);
          if (denied) {
            respond(false, undefined, denied);
            return;
          }
          const record = read.describe(query);
          if (
            !record ||
            (hasOperatorBoundary(client, read.state.policyConfig) &&
              presentation.sharing.entryFilter?.(record.key, record.entry) === false)
          ) {
            respond(true, { session: null });
            return;
          }
          respond(true, { session: presentation.present(record, params) });
        },
      );
      if (prepared.kind === "complete") {
        return;
      }
      const { certifySessionCanonicalValidationPending } =
        await import("../../config/sessions/session-canonical-validation-readiness.js");
      await certifySessionCanonicalValidationPending(prepared.database);
    }
  },
  "sessions.get": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationAuthorization,
  }) => {
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

    const projection = getSessionRowProjection(context);
    if (!projection) {
      throw new Error("Session projection is unavailable before Gateway startup completes");
    }
    const requestedAgent = () =>
      resolveRequestedSessionAgentId(
        context.getRuntimeConfig(),
        key,
        normalizeOptionalString(p.agentId),
      );
    const queries = () => {
      const requested = requestedAgent();
      return requested.ok ? [{ key, agentId: requested.agentId }] : [];
    };
    const selected = await withReadySessionRows(projection, queries, (read) => {
      sessionMutationAuthorization?.assertCurrent();
      const requested = requestedAgent();
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return undefined;
      }
      const record = read.describe({ key, agentId: requested.agentId });
      const policyConfig = read.state.policyConfig;
      const boundaryFilter = hasOperatorBoundary(client, policyConfig)
        ? createSessionListEntryFilter({ client, cfg: policyConfig })
        : undefined;
      if (!record?.entry.sessionId || boundaryFilter?.(record.key, record.entry) === false) {
        respond(true, { messages: [] }, undefined);
        return undefined;
      }
      return record;
    });
    if (!selected) {
      return;
    }
    const target = {
      agentId: selected.agentId,
      sessionEntry: { sessionId: selected.entry.sessionId },
      sessionId: selected.entry.sessionId,
      sessionKey: selected.key,
      storePath: selected.storeTarget.storePath,
    };
    const limits = {
      maxMessages: limit,
      maxLines: limit * 20 + 20,
      allowResetArchiveFallback: true,
    };
    const messages =
      selected.entry.incognito || isIncognitoSessionKey(selected.key)
        ? (await readRecentSessionMessagesWithStatsAsync(target, limits)).messages
        : await (
            await import("../../config/sessions/session-history-worker-runtime.js")
          ).readSessionHistoryPageInWorker(
            { kind: "recent", params: { target, ...limits } },
            signal,
          );
    await withReadySessionRows(projection, queries, (read) => {
      sessionMutationAuthorization?.assertCurrent();
      const requested = requestedAgent();
      const current = requested.ok
        ? read.describe({ key, agentId: requested.agentId }, selected)
        : undefined;
      const policyConfig = read.state.policyConfig;
      const boundaryFilter = hasOperatorBoundary(client, policyConfig)
        ? createSessionListEntryFilter({ client, cfg: policyConfig })
        : undefined;
      if (
        !current ||
        current.agentId !== selected.agentId ||
        current.key !== selected.key ||
        current.storeTarget.storePath !== selected.storeTarget.storePath ||
        current.entry.sessionId !== target.sessionId ||
        boundaryFilter?.(current.key, current.entry) === false
      ) {
        respond(true, { messages: [] }, undefined);
        return;
      }
      respond(true, { messages }, undefined);
    });
  },
};
