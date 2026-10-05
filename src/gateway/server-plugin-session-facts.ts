import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  RuntimeSessionFacts,
  RuntimeSessionFactsResult,
} from "../plugins/runtime/types-session-facts.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";
import {
  resolveProjectedControlUiSessionPrTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { withInProcessGatewayRead } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { requireSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionVisibility } from "./session-sharing.js";

const SESSION_FACTS_LIMIT = 40;
const SESSION_FACTS_PR_LOAD_LIMIT = 8;

function safeText(value: string | undefined, limit: number): string | undefined {
  return value ? truncateUtf16Safe(redactToolPayloadText(value), limit) : undefined;
}

/** Reads the Gateway's prepared rows and PR snapshots; optional enrichment stays with its owner. */
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
  const keys = [...new Set(params.sessionKeys.map((key) => key.trim()))].filter(
    (key) => !isIncognitoSessionKey(key),
  );
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Session facts are only available to bundled or trusted official plugins");
  }
  return await withInProcessGatewayRead(
    {
      method: "sessions.list",
      scope,
      resolveGatewayContext,
      callerAuthorityError: "Session facts caller authority is no longer active",
    },
    async (resolved, assertCurrent) => {
      const projection = requireSessionRowProjection(resolved.context);
      return await withReadySessionRows(
        projection,
        (cfg) =>
          keys.flatMap((key) => {
            const requested = resolveRequestedSessionAgentId(cfg, key);
            return requested.ok ? [{ key, agentId: requested.agentId }] : [];
          }),
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
          let prLoads = 0;
          const admitPrLoad = () => prLoads++ < SESSION_FACTS_PR_LOAD_LIMIT;
          const prOwner = resolved.context.controlUiSessionPullRequests;
          const prRetries: ControlUiSessionPrTarget[] = [];
          for (const key of keys) {
            const requested = resolveRequestedSessionAgentId(read.state.cfg, key);
            if (!requested.ok) {
              continue;
            }
            const query = { key, agentId: requested.agentId };
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
            const row = presentation.present(record, {
              includeDerivedTitles: true,
              includeLastMessage: true,
            });
            if (!row) {
              continue;
            }
            const prEligible = Boolean(row.worktree?.id || row.repositoryWorkspaceId);
            const target = prEligible
              ? resolveProjectedControlUiSessionPrTarget(read.state.cfg, record)
              : undefined;
            const cachedPrs = target ? prOwner?.readPrepared(target, () => false) : undefined;
            const pullRequests =
              cachedPrs ?? (target ? prOwner?.readPrepared(target, admitPrLoad) : undefined);
            const prUnavailable =
              prEligible &&
              (!pullRequests || pullRequests.status !== "ready" || pullRequests.rateLimited);
            unavailable ||= prUnavailable;
            if (target && cachedPrs && prUnavailable) {
              prRetries.push(target);
            }
            const digest = row.observerDigest ? record.entry.observerDigest : undefined;
            sessions.push({
              key: record.key,
              sessionId: record.entry.sessionId,
              ...(record.entry.lifecycleRevision
                ? { lifecycleRevision: record.entry.lifecycleRevision }
                : {}),
              agentId: record.agentId,
              label: safeText(row.label ?? row.displayName, 240),
              derivedTitle: safeText(row.derivedTitle, 240),
              lastMessagePreview: safeText(
                row.lastMessagePreview
                  ? stripMarkdown(row.lastMessagePreview, { linkStyle: "label", stripHtml: true })
                      .replace(/\s+/gu, " ")
                      .trim()
                  : undefined,
                400,
              ),
              run:
                row.hasActiveRun || row.status === "queued"
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
                pullRequests?.pullRequests.map(({ number, state, url, title }) => ({
                  number,
                  state,
                  ...(url ? { url } : {}),
                  ...(title ? { title: safeText(title, 120) } : {}),
                })) ?? [],
              ...(prUnavailable ? { pullRequestsUnavailable: true } : {}),
              ...(pullRequests?.rateLimited || pullRequests?.status === "rate-limited"
                ? { pullRequestsRateLimited: true }
                : {}),
              archived: row.archived === true,
              lastActivityAt: row.lastActivityAt ?? row.updatedAt ?? 0,
            });
          }
          // Admit cold keys before retries so one unavailable batch cannot starve later keys.
          for (const target of prRetries) {
            prOwner?.readPrepared(target, admitPrLoad);
          }
          return {
            sessions,
            ...(unavailable
              ? { warnings: ["Pull-request state is unavailable for some sessions."] }
              : {}),
          };
        },
      );
    },
  );
}
