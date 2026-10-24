import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDescribeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import {
  NativeSubagentsSnapshotSchema,
  type NativeSubagentsSnapshot,
} from "../../../packages/gateway-protocol/src/schema/native-subagents.js";
import { captureAgentHarnessLifecycleHooks } from "../../agents/harness/registry-lifecycle.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { projectOperatorModelRead } from "../operator-model-presentation.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
} from "../session-sharing.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import { createVisibleActiveSessionRunProjector } from "./session-active-runs.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const validateNativeSubagentsSnapshot = lazyCompile(NativeSubagentsSnapshotSchema);

export const sessionByKeyReadHandlers: GatewayRequestHandlers = {
  "sessions.describe": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
    signal,
  }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const projection = requireSessionRowProjection(context);
    const queries = (cfg: Parameters<typeof resolveRequestedSessionAgentId>[0]) => {
      const agent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
      const denied = authorizeIncognitoSessionTarget({
        client: client ?? null,
        sessionKey: key,
        target: null,
      });
      return agent.ok && !denied ? [{ key, agentId: agent.agentId }] : [];
    };
    const selected = await withReadySessionRows(projection, queries, (read) => {
      sessionMutationAuthorization?.assertCurrent();
      const requestedAgent = resolveRequestedSessionAgentId(read.state.cfg, key, params.agentId);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return undefined;
      }
      const query = { key, agentId: requestedAgent.agentId };
      const presentation = prepareProjectedSessionPresentation(
        read,
        client,
        Date.now(),
        createVisibleActiveSessionRunProjector(
          read.state.rowContext.projectedAgentRuns,
          undefined,
          context.resolveGatewayContext,
          read.physicalPaths,
        ),
      );
      const denied = presentation.authorizeDescription(query);
      if (denied) {
        respond(false, undefined, denied);
        return undefined;
      }
      const record = read.describe(query);
      if (
        !record ||
        (hasOperatorBoundary(client, read.state.policyConfig) &&
          presentation.sharing.entryFilter?.(record.key, record.entry) === false)
      ) {
        respond(true, { session: null });
        return undefined;
      }
      if (params.includeNativeSubagents) {
        return record;
      }
      respond(true, { session: presentation.present(record, params) });
      return undefined;
    });
    if (!selected) {
      return;
    }
    try {
      const readParams = {
        agentId: selected.agentId,
        sessionKey: selected.key,
        sessionId: selected.entry.sessionId,
        lifecycleRevision: selected.entry.lifecycleRevision,
        storePath: selected.storeTarget.storePath,
      };
      // Observe retained work even when its parent's selected runtime has since changed.
      const owners = captureAgentHarnessLifecycleHooks("readNativeSubagents");
      let active = true;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        sessionMutationAuthorization?.assertCurrent();
        if (!projection.isCurrent(selected)) {
          throw new Error("Session changed while reading native subagents");
        }
        if (!active || owners.some((owner) => !owner.isCurrent())) {
          throw new Error("Native subagent observation owner changed");
        }
      };
      try {
        assertCurrent();
        const snapshots = await Promise.all(
          owners.map(async (owner) => {
            const observed = await owner.prepare({ ...readParams, assertCurrent });
            assertCurrent();
            if (observed !== undefined && !validateNativeSubagentsSnapshot(observed)) {
              throw new Error("Invalid native subagent observation");
            }
            return (
              observed && {
                coverage: observed.coverage,
                children: observed.children.map((child) => ({
                  id: `${owner.registration.harness.id}:${child.id}`,
                  label: child.label,
                  status: child.status,
                })),
                truncated: observed.truncated,
              }
            );
          }),
        );
        const available = snapshots.filter((observed) => observed !== undefined);
        const children = available.flatMap((observed) => observed.children);
        const nativeSubagents: NativeSubagentsSnapshot | undefined = available.length
          ? {
              coverage: "live",
              children: children.slice(0, 128),
              truncated: children.length > 128 || available.some((observed) => observed.truncated),
            }
          : undefined;
        assertCurrent();
        if (nativeSubagents !== undefined && !validateNativeSubagentsSnapshot(nativeSubagents)) {
          throw new Error("Invalid combined native subagent observation");
        }
        await withReadySessionRows(projection, queries, (read) => {
          assertCurrent();
          sessionMutationAuthorization?.assertCurrent();
          const presentation = prepareProjectedSessionPresentation(
            read,
            client,
            Date.now(),
            createVisibleActiveSessionRunProjector(
              read.state.rowContext.projectedAgentRuns,
              undefined,
              context.resolveGatewayContext,
              read.physicalPaths,
            ),
          );
          const query = { key, agentId: selected.agentId };
          const denied = presentation.authorizeDescription(query);
          if (denied) {
            respond(false, undefined, denied);
            return;
          }
          const current = read.describe(query, selected);
          if (
            !current ||
            current.entry.sessionId !== selected.entry.sessionId ||
            current.entry.lifecycleRevision !== selected.entry.lifecycleRevision ||
            (hasOperatorBoundary(client, read.state.policyConfig) &&
              presentation.sharing.entryFilter?.(current.key, current.entry) === false)
          ) {
            respond(true, { session: null });
            return;
          }
          assertCurrent();
          respond(true, {
            session: presentation.present(current, params),
            ...(nativeSubagents === undefined ? {} : { nativeSubagents }),
          });
        });
      } finally {
        active = false;
      }
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Unable to read native subagents"),
      );
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
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit = resolveIntegerOption(p.limit, 200, { min: 1 });

    const projection = requireSessionRowProjection(context);
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
      respond(
        true,
        projectOperatorModelRead({ context, client, agentId: current.agentId }, { messages }),
        undefined,
      );
    });
  },
};
