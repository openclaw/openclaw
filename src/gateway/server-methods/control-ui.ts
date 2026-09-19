import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../../agents/github-tool-identity.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import type {
  ControlUiSessionPullRequestChecksParams,
  loadControlUiSessionPullRequestChecks,
} from "../control-ui-session-pr-check-details.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { gitHubPublicApi, type ControlUiGitHubPreviewIdentity } from "../github-public-api.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { buildGatewaySessionRow } from "../session-utils.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { loadSessionEntriesForTarget } from "./sessions-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type LoadGitHubPreview = typeof gitHubPublicApi.loadControlUiGitHubPreview;

async function prepareControlUiGitHubIdentity(
  { context, client, signal }: GatewayRequestHandlerOptions,
  agentId: string,
): Promise<{
  identity: ControlUiGitHubPreviewIdentity | undefined;
  assertSelected: () => void;
}> {
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
  const assertActive = () => {
    if (
      signal?.aborted ||
      (client?.connId &&
        !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  // Without a managed selection, retain service/env/anonymous access without
  // probing native gh. Both paths must still own the selection at delivery.
  const identity = configuredIdentity()
    ? await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive,
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      })
    : undefined;
  return {
    identity,
    assertSelected:
      identity?.assertSelected ??
      (() => {
        assertActive();
        if (configuredIdentity()) {
          throw new GitHubIdentityError("changed");
        }
      }),
  };
}

type SessionPreviewSource = {
  sessionKey: string;
  title?: string;
  derivedTitle?: string;
  agentId: string;
  kind?: string;
  channel?: string;
  updatedAt?: number | null;
  lastMessagePreview?: string;
  archived?: boolean;
};

type LoadSessionPreview = (
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
) => SessionPreviewSource | null | Promise<SessionPreviewSource | null>;

const SESSION_PREVIEW_TEXT_MAX_CHARS = 200;

function boundedPreviewText(value: string | undefined, maxChars = SESSION_PREVIEW_TEXT_MAX_CHARS) {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxChars) : undefined;
}

function parseSessionPreviewKey(params: unknown): string | null {
  if (!isRecord(params) || Object.keys(params).some((key) => key !== "sessionKey")) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  return sessionKey && sessionKey.length <= 512 ? sessionKey : null;
}

function projectSessionPreview(source: SessionPreviewSource | null): ControlUiSessionPreview {
  if (!source) {
    return { status: "unavailable" };
  }
  const lastMessagePreview = boundedPreviewText(
    source.lastMessagePreview ? redactToolPayloadText(source.lastMessagePreview) : undefined,
  );
  const title = boundedPreviewText(source.title);
  const derivedTitle = boundedPreviewText(source.derivedTitle);
  const kind = boundedPreviewText(source.kind, 64);
  const channel = boundedPreviewText(source.channel, 80);
  return {
    status: "ok",
    sessionKey: source.sessionKey,
    agentId: source.agentId,
    ...(title ? { title } : {}),
    ...(derivedTitle ? { derivedTitle } : {}),
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
      ? { updatedAt: source.updatedAt }
      : {}),
    ...(lastMessagePreview ? { lastMessagePreview } : {}),
    ...(typeof source.archived === "boolean" ? { archived: source.archived } : {}),
  };
}

function loadControlUiSessionPreview(
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
): SessionPreviewSource | null {
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey);
  if (!requestedAgent.ok) {
    return null;
  }
  const { target, storePath, store, entry } = loadSessionEntriesForTarget({
    key: sessionKey,
    cfg,
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (!entry) {
    return null;
  }
  // Hover previews must not reveal more than sessions.list: apply the same
  // incognito/draft sharing predicate so a member cannot preview-by-key a
  // session the sidebar hides from them.
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (entryFilter && !entryFilter(target.canonicalKey, entry)) {
    return null;
  }
  const row = buildGatewaySessionRow({
    cfg,
    agentId: target.agentId,
    storePath,
    store,
    key: target.canonicalKey,
    entry,
    includeDerivedTitles: true,
    includeLastMessage: true,
    skipTranscriptUsageFallback: true,
  });
  return {
    sessionKey: row.key,
    agentId: target.agentId,
    title: row.displayName,
    derivedTitle: row.derivedTitle,
    kind: row.kind,
    channel: row.channel,
    updatedAt: row.updatedAt,
    lastMessagePreview: row.lastMessagePreview,
    archived: row.archived,
  };
}

function parseCheckDetailsParams(
  params: Record<string, unknown>,
): ControlUiSessionPullRequestChecksParams | null {
  if (
    Object.keys(params).some(
      (key) => !["sessionKey", "owner", "repo", "number", "headSha"].includes(key),
    )
  ) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  const headSha = typeof params.headSha === "string" ? params.headSha : "";
  const target = gitHubPublicApi.parseControlUiGitHubPreviewTarget({ ...params, kind: "pull" });
  return target && sessionKey && sessionKey.length <= 512 && /^[0-9a-f]{40}$/i.test(headSha)
    ? {
        sessionKey,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        headSha: headSha.toLowerCase(),
      }
    : null;
}

function resolveCheckDetailsSession(
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
): { sessionScope: string; agentId: string } | null {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedGlobalAgentId(cfg, sessionKey);
  if (!requested.ok) {
    return null;
  }
  const { target, entry } = loadSessionEntriesForTarget({
    key: sessionKey,
    cfg,
    agentId: requested.agentId,
  });
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (!entry?.sessionId || (entryFilter && !entryFilter(target.canonicalKey, entry))) {
    return null;
  }
  const repository = entry.repositoryWorkspaceId
    ? getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId)
    : undefined;
  return {
    agentId: target.agentId,
    sessionScope: JSON.stringify([
      target.agentId,
      target.canonicalKey,
      entry.sessionId,
      entry.lifecycleRevision,
      entry.repositoryWorkspaceId,
      repository?.url,
      repository?.branch,
      entry.spawnedCwd,
      entry.spawnedWorkspaceDir,
      resolveAgentWorkspaceDir(cfg, target.agentId),
    ]),
  };
}

async function loadSessionCheckDetails(
  ...args: Parameters<typeof loadControlUiSessionPullRequestChecks>
): ReturnType<typeof loadControlUiSessionPullRequestChecks> {
  const { loadControlUiSessionPullRequestChecks } =
    await import("../control-ui-session-pr-check-details.js");
  return loadControlUiSessionPullRequestChecks(...args);
}

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = (...args) =>
    gitHubPublicApi.loadControlUiGitHubPreview(...args),
  loadSessionPreview: LoadSessionPreview = loadControlUiSessionPreview,
  loadChecks: typeof loadControlUiSessionPullRequestChecks = loadSessionCheckDetails,
): GatewayRequestHandlers {
  return {
    "controlUi.linkPreview": async ({ params, context, respond, signal }) => {
      const isEnabled = () =>
        context.getRuntimeConfig().gateway?.controlUi?.automaticallyFetchFavicons !== false;
      if (!isEnabled()) {
        respond(true, {}, undefined);
        return;
      }
      const { parseControlUiLinkPreviewUrl, loadControlUiLinkPreview } =
        await import("../control-ui-link-preview.js");
      const url = Object.keys(params).every((key) => key === "url")
        ? parseControlUiLinkPreviewUrl(params.url)
        : null;
      if (!url) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.linkPreview params"),
        );
        return;
      }
      const preview = await loadControlUiLinkPreview(url, isEnabled);
      respond(true, !signal?.aborted && isEnabled() ? preview : {}, undefined);
    },
    "controlUi.githubPreview": async (options) => {
      const { params, respond, context } = options;
      const target = gitHubPublicApi.parseControlUiGitHubPreviewTarget(params);
      if (!target || (params.refresh !== undefined && typeof params.refresh !== "boolean")) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.githubPreview params"),
        );
        return;
      }
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
        normalize: normalizeOptionalString,
      });
      if (!resolved) {
        return;
      }
      try {
        const { identity, assertSelected } = await prepareControlUiGitHubIdentity(
          options,
          resolved.agentId,
        );
        const preview =
          params.refresh === true
            ? await loadGitHubPreview(target, identity, undefined, true)
            : await loadGitHubPreview(target, identity);
        assertSelected();
        respond(true, preview, undefined);
      } catch (error) {
        const { message, ...details } =
          error instanceof GitHubIdentityError
            ? { message: error.message, retryable: error.reason !== "unavailable" }
            : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
      }
    },
    "controlUi.sessionPreview": async ({ params, client, context, respond }) => {
      const sessionKey = parseSessionPreviewKey(params);
      if (!sessionKey) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPreview params"),
        );
        return;
      }
      try {
        respond(
          true,
          projectSessionPreview(await loadSessionPreview(sessionKey, context, client)),
          undefined,
        );
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Session preview unavailable"),
        );
      }
    },
    "controlUi.sessionPullRequests.checks": async ({
      params,
      client,
      context,
      respond,
      signal,
    }) => {
      const parsed = parseCheckDetailsParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid controlUi.sessionPullRequests.checks params",
          ),
        );
        return;
      }
      try {
        const binding = resolveCheckDetailsSession(parsed.sessionKey, context, client);
        if (!binding) {
          throw new gitHubPublicApi.ControlUiGitHubError(404, "Session CI details unavailable");
        }
        const assertCurrent = () => {
          const current = resolveCheckDetailsSession(parsed.sessionKey, context, client);
          if (
            signal?.aborted ||
            current?.sessionScope !== binding.sessionScope ||
            (client?.connId &&
              !context.getClientConnIds?.((candidate) => candidate === client).has(client.connId))
          ) {
            throw new gitHubPublicApi.ControlUiGitHubError(
              409,
              "Session changed; reopen CI details",
            );
          }
        };
        const result = await loadChecks(
          { ...parsed, agentId: binding.agentId },
          { ...binding, assertCurrent },
        );
        assertCurrent();
        respond(true, result, undefined);
      } catch (error) {
        const message =
          error instanceof gitHubPublicApi.ControlUiGitHubError &&
          (error.statusCode === 404 || error.statusCode === 409)
            ? error.message
            : gitHubPublicApi.formatControlUiGitHubPreviewError(error).message;
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    "controlUi.sessionPullRequests.subscribe": ({ params, client, context, respond }) => {
      const parsed = parseControlUiSessionPullRequestsSubscribeParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid controlUi.sessionPullRequests.subscribe params",
          ),
        );
        return;
      }
      const connId = client?.connId?.trim();
      const subscriptions = context.controlUiSessionPullRequests;
      if (!connId || !subscriptions) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "session pull request subscriptions unavailable"),
        );
        return;
      }
      if (parsed.refreshSessionKeys.length > 0) {
        void subscriptions.replace(connId, parsed.sessionKeys, new Set(parsed.refreshSessionKeys));
      } else {
        void subscriptions.replace(connId, parsed.sessionKeys);
      }
      respond(true, { subscribed: parsed.sessionKeys.length > 0 }, undefined);
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
