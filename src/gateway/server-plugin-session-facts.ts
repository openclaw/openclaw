import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  RuntimeSessionFacts,
  RuntimeSessionFactsResult,
} from "../plugins/runtime/types-session-facts.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { ControlUiSessionPullRequestSnapshot } from "./control-ui-contract.js";
import {
  prepareControlUiSessionPrRead,
  resolveControlUiSessionPrTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { withInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import { backfillSessionRowTranscriptFields } from "./session-row-transcript-backfill.js";
import { resolveSessionVisibility } from "./session-sharing.js";

const SESSION_FACTS_LIMIT = 40;
type PreparedSessionFacts = {
  record: MaterializedRow;
  target: ControlUiSessionPrTarget;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  lastMessagePreview?: string;
};

function safeText(value: string | undefined, limit: number): string | undefined {
  return value ? truncateUtf16Safe(redactToolPayloadText(value), limit) : undefined;
}

/** The caller's bound Gateway owns both row admission and the canonical PR cache. */
export async function readTrustedPluginSessionFacts(
  params: { sessionKeys: readonly string[] },
  resolveGatewayContext?: GatewayContextResolver,
): Promise<RuntimeSessionFactsResult> {
  if (
    !Array.isArray(params.sessionKeys) ||
    params.sessionKeys.length > SESSION_FACTS_LIMIT ||
    params.sessionKeys.some(
      (key) =>
        typeof key !== "string" || !key.trim() || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH,
    )
  ) {
    throw new Error(
      `Session facts require at most 40 nonempty session keys of at most ${CHAT_SEND_SESSION_KEY_MAX_LENGTH} characters`,
    );
  }
  const keys = [...new Set(params.sessionKeys.map((key) => key.trim()))];
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Session facts are only available to bundled or trusted official plugins");
  }
  return await withInProcessGatewayDispatch(
    "sessions.list",
    {},
    {
      forceSyntheticClient: true,
      pluginRuntimeOwnerId: scope?.pluginId,
      resolveGatewayContext,
      syntheticScopes: ["operator.read"],
      ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
    },
    async (resolved) => {
      const assertLifetime = () => {
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
        scope?.signal?.throwIfAborted();
        if (resolved.hasCurrentClientAuthority?.() === false) {
          throw new Error("Session facts caller authority is no longer active");
        }
      };
      const { authorizeGatewayRequestPreDispatch, createRequestGatewayMethodRegistry } =
        await import("./server-methods.js");
      assertLifetime();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method: "sessions.list",
        requestParams: {},
        client: resolved.client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
        assertInvocationCurrent: assertLifetime,
      });
      try {
        const assertCurrent = () => {
          assertLifetime();
          if (authorization.error) {
            throw new Error(authorization.error.message);
          }
          authorization.sessionAccessAuthority?.assertCurrent();
          authorization.sessionMutationAuthorization?.assertCurrent();
        };
        assertCurrent();
        const projection = getSessionRowProjection(resolved.context);
        if (!projection) {
          throw new Error("Session projection is unavailable before Gateway startup completes");
        }
        const prOwner = resolved.context.controlUiSessionPullRequests;
        const prepared: PreparedSessionFacts[] = [];
        const refreshPreview = async (candidate: PreparedSessionFacts, record: MaterializedRow) => {
          // Exact row readiness excludes optional transcript enrichment, including on cold boards.
          const fields = await backfillSessionRowTranscriptFields({
            agentId: record.agentId,
            storeAgentId: record.storeTarget.agentId,
            storePath: record.storeTarget.storePath,
            sessionKey: record.key,
            sessionId: record.entry.sessionId,
            sessionEntry: record.entry,
            shouldCommit: () => {
              assertCurrent();
              return projection.isCurrent(record);
            },
          });
          assertCurrent();
          candidate.record = record;
          candidate.lastMessagePreview = fields.lastMessagePreview;
        };
        for (const sessionKey of keys) {
          // Board caches are durable projections; never copy process-private conversations.
          if (isIncognitoSessionKey(sessionKey)) {
            continue;
          }
          const readCurrent = await prepareControlUiSessionPrRead({
            client: resolved.client,
            sessionKey,
            getRuntimeConfig: resolved.context.getRuntimeConfig,
            getSessionRowProjection: () => getSessionRowProjection(resolved.context),
            isCurrentClient: () => {
              assertCurrent();
              return true;
            },
          });
          assertCurrent();
          const target = await readCurrent?.();
          assertCurrent();
          if (!target) {
            continue;
          }
          let pullRequests: ControlUiSessionPullRequestSnapshot | undefined;
          if (prOwner) {
            try {
              pullRequests = await prOwner.read(target, assertCurrent);
            } catch {
              assertCurrent();
            }
          }
          assertCurrent();
          const currentTarget = await readCurrent?.();
          assertCurrent();
          if (!currentTarget || currentTarget.identity !== target.identity) {
            continue;
          }
          const record = await withReadySessionRows(
            projection,
            () => [{ key: target.params.sessionKey, agentId: target.params.agentId }],
            (read) => {
              assertCurrent();
              currentTarget.assertCurrent?.();
              const selected = read.describe({
                key: target.params.sessionKey,
                agentId: target.params.agentId,
              });
              // Drafts are creator-private; a service-scoped read has no sharing filter, so
              // exclude them before any preview enrichment or model dispatch.
              return selected &&
                !selected.entry.incognito &&
                resolveSessionVisibility(selected.entry) !== "draft"
                ? selected
                : undefined;
            },
          );
          if (!record) {
            continue;
          }
          const candidate: PreparedSessionFacts = { record, target, pullRequests };
          await refreshPreview(candidate, record);
          prepared.push(candidate);
        }
        // A normal activity publication replaces a row without replacing its session.
        // Reauthorize and present the whole batch together after asynchronous reads.
        for (let pass = 0; ; pass += 1) {
          const previewsToRefresh: Array<{
            candidate: PreparedSessionFacts;
            record: MaterializedRow;
          }> = [];
          const snapshot = await withReadySessionRows(
            projection,
            () => prepared.map(({ record }) => ({ key: record.key, agentId: record.agentId })),
            (read) => {
              assertCurrent();
              const presentation = prepareProjectedSessionPresentation(
                read,
                resolved.client,
                Date.now(),
                createVisibleActiveSessionRunProjector(
                  resolved.context,
                  read.state.rowContext.projectedAgentRuns,
                ),
              );
              const sessions: RuntimeSessionFacts[] = [];
              let unavailable = false;
              for (const candidate of prepared) {
                if (!projection.isCurrent(candidate.record)) {
                  continue;
                }
                const query = { key: candidate.record.key, agentId: candidate.record.agentId };
                if (presentation.authorizeDescription(query)) {
                  continue;
                }
                const record = read.describe(query);
                if (
                  !record ||
                  record.entry.incognito ||
                  resolveSessionVisibility(record.entry) === "draft" ||
                  presentation.sharing.entryFilter?.(record.key, record.entry) === false
                ) {
                  continue;
                }
                const target = resolveControlUiSessionPrTarget(
                  {
                    cfg: read.state.cfg,
                    agentId: record.agentId,
                    canonicalKey: record.key,
                    storePath: record.storeTarget.storePath,
                    readSource: {
                      agentId: record.storeTarget.agentId,
                      path: record.storeTarget.storePath,
                    },
                    entry: record.entry,
                  },
                  record.materialized.row.repository ?? null,
                );
                if (target?.identity !== candidate.target.identity) {
                  continue;
                }
                if (record.entry !== candidate.record.entry) {
                  previewsToRefresh.push({ candidate, record });
                  continue;
                }
                const row = presentation.present(record, {
                  includeDerivedTitles: true,
                  includeLastMessage: true,
                });
                if (!row) {
                  continue;
                }
                const digest = row.observerDigest ? record.entry.observerDigest : undefined;
                const { pullRequests } = candidate;
                const prUnavailable =
                  !pullRequests || pullRequests.status !== "ready" || pullRequests.rateLimited;
                unavailable ||= prUnavailable;
                sessions.push({
                  key: record.key,
                  sessionId: record.entry.sessionId,
                  ...(record.entry.lifecycleRevision
                    ? { lifecycleRevision: record.entry.lifecycleRevision }
                    : {}),
                  agentId: record.agentId,
                  label: safeText(row.label ?? row.displayName, 240),
                  derivedTitle: safeText(row.derivedTitle, 240),
                  lastMessagePreview: safeText(candidate.lastMessagePreview, 400),
                  run:
                    row.hasActiveRun || row.status === "running" || row.status === "queued"
                      ? "active"
                      : row.status === "failed" ||
                          row.status === "killed" ||
                          row.status === "timeout" ||
                          row.lastRunError
                        ? "failed"
                        : "idle",
                  ...(digest
                    ? {
                        observerDigest: {
                          health: digest.health,
                          headline: safeText(digest.headline, 120) ?? "",
                          assessment: safeText(digest.assessment, 320),
                          revision: digest.revision,
                        },
                      }
                    : {}),
                  pullRequests:
                    pullRequests?.pullRequests.map(({ number, state }) => ({ number, state })) ??
                    [],
                  ...(prUnavailable ? { pullRequestsUnavailable: true } : {}),
                  archived: row.archived === true,
                  lastActivityAt: row.lastActivityAt ?? row.updatedAt ?? 0,
                });
              }
              return {
                sessions,
                ...(unavailable
                  ? { warnings: ["Pull-request state is unavailable for some sessions."] }
                  : {}),
              };
            },
          );
          if (previewsToRefresh.length === 0) {
            return snapshot;
          }
          // Bound worker reads under continual activity rather than returning mixed-age facts.
          if (pass >= 2) {
            throw new Error("Session facts changed while reading message previews; retry the read");
          }
          for (const { candidate, record } of previewsToRefresh) {
            await refreshPreview(candidate, record);
          }
        }
      } finally {
        authorization.sessionAccessAuthority?.release();
      }
    },
  );
}
