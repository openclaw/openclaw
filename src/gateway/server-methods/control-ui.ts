import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { GitHubIdentityError } from "../../agents/github-tool-identity.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { ControlUiLinkReaderSection } from "../../shared/control-ui-link-reader.js";
import { truncateOptionalText } from "../../shared/text-truncate.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import { withControlUiSessionGitHubRead } from "../control-ui-session-github-read.js";
import type { ControlUiSessionPullRequestChecksParams } from "../control-ui-session-pr-check-details.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import {
  gitHubPublicApi,
  type ControlUiGitHubPreviewIdentity,
  type ControlUiGitHubSessionIdentity,
} from "../github-public-api.js";
import { prepareGitHubReaderIdentity } from "../github-reader-identity.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { respondError } from "./response.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

class GitHubReadRequestInactiveError extends Error {
  constructor() {
    super("GitHub request is no longer active. Try again.");
  }
}

async function prepareControlUiGitHubIdentity(
  { context, client, signal, hasCurrentClientAuthority }: GatewayRequestHandlerOptions,
  agentId: string,
) {
  // Nested plugin requests may decorate the client; transport authority retains its owner.
  const assertActive = () => {
    if (
      signal?.aborted ||
      (hasCurrentClientAuthority
        ? !hasCurrentClientAuthority()
        : client?.connId &&
          !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw new GitHubReadRequestInactiveError();
    }
  };
  return prepareGitHubReaderIdentity(context, agentId, assertActive);
}

function createGitHubReadHandler<
  T extends NonNullable<ReturnType<typeof gitHubPublicApi.parseGitHubTarget>>,
>(
  method: string,
  parseTarget: (params: unknown) => T | null,
  load: (
    target: T,
    identity?: ControlUiGitHubPreviewIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
    section?: ControlUiLinkReaderSection,
  ) => Promise<unknown>,
  loadSession: (
    target: T,
    identity: ControlUiGitHubSessionIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
    section?: ControlUiLinkReaderSection,
  ) => Promise<unknown>,
): GatewayRequestHandlers[string] {
  return async (options) => {
    const { params, respond, context } = options;
    const target = parseTarget(params);
    const section = params.section;
    if (
      !target ||
      (params.refresh !== undefined && typeof params.refresh !== "boolean") ||
      (section !== undefined &&
        (method !== "controlUi.githubDetail" ||
          (section !== "overview" &&
            section !== "checks" &&
            section !== "files" &&
            section !== "discussion")))
    ) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, `invalid ${method} params`);
      return;
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: context.getRuntimeConfig(),
    });
    if (!resolved) {
      return;
    }
    const startedAt = performance.now();
    let preparedAt: number | undefined;
    try {
      if (params.sessionKey !== undefined || params.githubHost !== undefined) {
        await withControlUiSessionGitHubRead(
          options,
          resolved.agentId,
          target,
          (identity) => loadSession(target, identity, undefined, params.refresh === true, section),
          (result) => respond(true, result, undefined),
        );
        return;
      }
      const { identity, assertSelected } = await prepareControlUiGitHubIdentity(
        options,
        resolved.agentId,
      );
      assertSelected();
      preparedAt = performance.now();
      const result = await load(target, identity, undefined, params.refresh === true, section);
      assertSelected();
      respond(true, result, undefined);
    } catch (error) {
      const { message, ...details } =
        error instanceof GitHubReadRequestInactiveError
          ? { message: error.message, retryable: false }
          : error instanceof GitHubIdentityError
            ? // Retained reader content requires current authority, even when a
              // later identity-verification attempt could succeed.
              { message: error.message, retryable: false }
            : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
    } finally {
      const finishedAt = performance.now();
      if (method === "controlUi.githubPreview" && finishedAt - startedAt >= 500) {
        context.logGateway?.info("Slow GitHub preview handler", {
          identityMs: Math.round((preparedAt ?? finishedAt) - startedAt),
          loadMs: preparedAt === undefined ? 0 : Math.round(finishedAt - preparedAt),
        });
      }
    }
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

const SESSION_PREVIEW_TEXT_MAX_CHARS = 200;

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
  const lastMessagePreview = truncateOptionalText(
    source.lastMessagePreview,
    SESSION_PREVIEW_TEXT_MAX_CHARS,
  );
  const title = truncateOptionalText(source.title, SESSION_PREVIEW_TEXT_MAX_CHARS);
  const derivedTitle = truncateOptionalText(source.derivedTitle, SESSION_PREVIEW_TEXT_MAX_CHARS);
  const kind = truncateOptionalText(source.kind, 64);
  const channel = truncateOptionalText(source.channel, 80);
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

async function withControlUiSessionPreview(
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
  consume: (preview: SessionPreviewSource | null) => void,
): Promise<void> {
  const projection = getSessionRowProjection(context);
  if (!projection) {
    consume(null);
    return;
  }
  const previewConfig = context.getRuntimeConfig();
  const previewOwner = resolveRequestedGlobalAgentId(previewConfig, sessionKey);
  const preview = previewOwner.ok
    ? projection.readPreview({ key: sessionKey, agentId: previewOwner.agentId })
    : null;
  if (
    preview !== undefined &&
    !(
      operatorSessionCap(client, previewConfig) === "invited" &&
      projection.needsMembershipPreparation()
    )
  ) {
    const entryFilter = createSessionListEntryFilter({
      client,
      cfg: previewConfig,
      membership: previewOwner.ok
        ? projection.readMembership({ key: sessionKey, agentId: previewOwner.agentId })
        : undefined,
    });
    consume(
      preview && (!entryFilter || entryFilter(preview.sessionKey, preview.entry)) ? preview : null,
    );
    return;
  }
  await withReadySessionRows(
    projection,
    (cfg) => {
      const owner = resolveRequestedGlobalAgentId(cfg, sessionKey);
      return owner.ok ? [{ key: sessionKey, agentId: owner.agentId }] : [];
    },
    (read) => {
      const cfg = context.getRuntimeConfig();
      const owner = resolveRequestedGlobalAgentId(cfg, sessionKey);
      const record = owner.ok
        ? read.describe({ key: sessionKey, agentId: owner.agentId })
        : undefined;
      // Hover previews follow list visibility, including after asynchronous preparation.
      const entryFilter = createSessionListEntryFilter({
        client,
        cfg,
        membership: record?.membership,
      });
      if (!record || (entryFilter && !entryFilter(record.key, record.entry))) {
        consume(null);
        return;
      }
      const row = read.present(record, { includeDerivedTitles: true, includeLastMessage: true });
      consume({
        sessionKey: row.key,
        agentId: record.agentId,
        title: row.displayName,
        derivedTitle: row.derivedTitle,
        kind: row.kind,
        channel: row.channel,
        updatedAt: row.updatedAt,
        lastMessagePreview: row.lastMessagePreview,
        archived: row.archived,
      });
    },
  );
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
  return target?.kind === "pull" &&
    sessionKey &&
    sessionKey.length <= 512 &&
    /^[0-9a-f]{40}$/i.test(headSha)
    ? {
        sessionKey,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        headSha: headSha.toLowerCase(),
      }
    : null;
}

export const controlUiHandlers: GatewayRequestHandlers = {
  "controlUi.linkPreview": async ({
    params,
    client,
    context,
    respond,
    signal,
    hasCurrentClientAuthority,
  }) => {
    const revision = () =>
      JSON.stringify([
        getRuntimeConfigSnapshotMetadata()?.revision,
        client?.authenticatedUserId,
        client?.authenticatedUserProfile?.profileId,
      ]);
    const scope = { principal: client ?? context, revision: revision() };
    const isEnabled = () =>
      !client?.connectionSignal?.aborted &&
      hasCurrentClientAuthority?.() !== false &&
      revision() === scope.revision &&
      context.getRuntimeConfig().gateway?.controlUi?.automaticallyFetchFavicons !== false;
    if (signal?.aborted || !isEnabled()) {
      respond(true, {}, undefined);
      return;
    }
    const { parseControlUiLinkPreviewUrl, loadControlUiLinkPreview } =
      await import("../control-ui-link-preview.js");
    const url = Object.keys(params).every((key) => key === "url")
      ? parseControlUiLinkPreviewUrl(params.url)
      : null;
    if (!url) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "invalid controlUi.linkPreview params");
      return;
    }
    const preview = await loadControlUiLinkPreview(url, isEnabled, scope);
    respond(true, !signal?.aborted && isEnabled() ? preview : {}, undefined);
  },
  "controlUi.githubPreview": createGitHubReadHandler(
    "controlUi.githubPreview",
    (params) => gitHubPublicApi.parseControlUiGitHubPreviewTarget(params),
    (...args: Parameters<typeof gitHubPublicApi.loadControlUiGitHubPreview>) =>
      gitHubPublicApi.loadControlUiGitHubPreview(...args),
    (target, identity, fetchImpl) =>
      gitHubPublicApi.loadSessionGitHubPreview(target, identity, fetchImpl),
  ),
  "controlUi.githubDetail": createGitHubReadHandler(
    "controlUi.githubDetail",
    (params) => gitHubPublicApi.parseGitHubTarget(params),
    (target, identity, fetchImpl, refresh, section) =>
      gitHubPublicApi.loadGitHubDetail(target, identity, fetchImpl, refresh, undefined, section),
    (...args) => gitHubPublicApi.loadSessionGitHubDetail(...args),
  ),
  "controlUi.sessionPreview": async ({
    params,
    client,
    context,
    respond,
    signal,
    hasCurrentClientAuthority,
  }) => {
    const sessionKey = parseSessionPreviewKey(params);
    if (!sessionKey) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPreview params");
      return;
    }
    try {
      while (!getSubagentSessionListReadSnapshotIdentity()) {
        await prepareSubagentSessionListReadCache();
      }
      signal?.throwIfAborted();
      const consume = (preview: SessionPreviewSource | null) => {
        signal?.throwIfAborted();
        if (hasCurrentClientAuthority?.() === false) {
          throw new Error("Session preview request is no longer active");
        }
        respond(true, projectSessionPreview(preview), undefined);
      };
      await withControlUiSessionPreview(sessionKey, context, client, consume);
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Session preview unavailable"));
    }
  },
  "controlUi.sessionPullRequests.checks": async (options) => {
    const { params, respond, signal } = options;
    const parsed = parseCheckDetailsParams(params);
    if (!parsed) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "invalid controlUi.sessionPullRequests.checks params",
      );
      return;
    }
    try {
      const requestRead = (
        await import("../control-ui-session-pr-request-read.js")
      ).prepareNativeRepositorySessionRequestRead(options);
      await requestRead.withRead(
        { sessionKey: parsed.sessionKey, allowOwnImportedPullRequest: true },
        async (read, request) => {
          if (!read) {
            throw new gitHubPublicApi.ControlUiGitHubError(404, "Session CI details unavailable");
          }
          const assertCurrent = () => {
            signal?.throwIfAborted();
            try {
              read.assertCurrent();
            } catch {
              throw new gitHubPublicApi.ControlUiGitHubError(
                409,
                "Session changed; reopen CI details",
              );
            }
            try {
              requestRead.assertCurrent();
            } catch {
              throw new gitHubPublicApi.ControlUiGitHubError(
                409,
                "Session changed; reopen CI details",
              );
            }
          };
          let result;
          try {
            result = await request.checks(read, parsed, assertCurrent);
          } finally {
            assertCurrent();
          }
          respond(true, result, undefined);
        },
      );
    } catch (error) {
      const message =
        error instanceof gitHubPublicApi.ControlUiGitHubError &&
        (error.statusCode === 404 || error.statusCode === 409)
          ? error.message
          : gitHubPublicApi.formatControlUiGitHubPreviewError(error).message;
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "controlUi.sessionPullRequests.subscribe": async (options) => {
    const { params, context, respond } = options;
    const parsed = parseControlUiSessionPullRequestsSubscribeParams(params);
    if (!parsed) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "invalid controlUi.sessionPullRequests.subscribe params",
      );
      return;
    }
    let requestRead;
    try {
      requestRead = (
        await import("../control-ui-session-pr-request-read.js")
      ).prepareNativeRepositorySessionRequestRead(options);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session pull request subscriptions unavailable"),
      );
      return;
    }
    const preparationError = await new Promise<unknown>((resolve) => {
      const replacement = requestRead.replaceSubscriptions({
        sessionKeys: parsed.sessionKeys,
        refresh:
          parsed.refreshSessionKeys.length > 0 ? new Set(parsed.refreshSessionKeys) : undefined,
        admitted: () => resolve(undefined),
        passive: parsed.passiveSessionKeys ? new Set(parsed.passiveSessionKeys) : undefined,
      });
      void replacement.catch((error: unknown) => {
        resolve(error);
        context.logGateway.warn(
          `Failed to prepare Control UI pull request subscriptions; retry the subscription: ${String(error)}`,
        );
      });
    });
    if (preparationError) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "session pull request subscriptions unavailable; retry the subscription",
        ),
      );
      return;
    }
    respond(
      true,
      { subscribed: parsed.sessionKeys.length > 0 || Boolean(parsed.passiveSessionKeys?.length) },
      undefined,
    );
  },
};
