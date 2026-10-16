import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { GitHubIdentityError } from "../../agents/github-tool-identity.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { ControlUiLinkReaderSection } from "../../shared/control-ui-link-reader.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import { withControlUiSessionGitHubRead } from "../control-ui-session-github-read.js";
import type {
  ControlUiSessionPullRequestChecksParams,
  loadControlUiSessionPullRequestChecks,
} from "../control-ui-session-pr-check-details.js";
import {
  prepareControlUiSessionPrRead,
  resolveControlUiSessionPrTarget,
  type ControlUiSessionPrReadContext,
  type ControlUiSessionPrTarget,
} from "../control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "../control-ui-session-pr-source.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import {
  gitHubPublicApi,
  type ControlUiGitHubPreviewIdentity,
  type ControlUiGitHubSessionIdentity,
} from "../github-public-api.js";
import { prepareGitHubReaderIdentity } from "../github-reader-identity.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type LoadGitHubPreview = typeof gitHubPublicApi.loadControlUiGitHubPreview;

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
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params`));
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
  const lastMessagePreview = boundedPreviewText(source.lastMessagePreview || undefined);
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
  if (preview !== undefined) {
    const entryFilter = createSessionListEntryFilter({ client, cfg: previewConfig });
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
      const entryFilter = createSessionListEntryFilter({ client, cfg });
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

async function prepareCheckDetailsSession(
  sessionKey: string,
  context: GatewayRequestContext,
  assertRequestCurrent: () => void,
): Promise<(ControlUiSessionPrTarget & { release: () => void }) | null> {
  const sourceCfg = context.getRuntimeConfig();
  const sourceRequest = resolveRequestedGlobalAgentId(sourceCfg, sessionKey);
  if (!sourceRequest.ok) {
    return null;
  }
  // Internal reads share the durable/memory lifetime owner; missing clients
  // still obey role visibility and never acquire system-actor authority.
  const fields = [
    "repositoryWorkspaceId",
    "worktree",
    "spawnedCwd",
    "spawnedWorkspaceDir",
    "pendingWorktree",
    "pendingProjectGitUrl",
    "deviceFolder",
  ] as const;
  const selected = await retainGatewaySessionEntryReadOnly(
    sessionKey,
    sourceRequest.agentId,
    (previous: InternalSessionEntry, current: InternalSessionEntry) =>
      fields.every((field) => isDeepStrictEqual(previous[field], current[field])),
    sourceCfg,
    { exactRead: true },
  );
  let retained = false;
  try {
    const entry = selected.entry;
    if (!entry?.sessionId) {
      return null;
    }
    const workspaceId = entry.repositoryWorkspaceId;
    const prepared = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const current = () => {
      assertRequestCurrent();
      const cfg = context.getRuntimeConfig();
      if (
        !selected.isCurrentAtResponse() ||
        createSessionListEntryFilter({ cfg, client: null })?.(selected.canonicalKey, entry) ===
          false
      ) {
        return undefined;
      }
      const repository = prepared?.current();
      return resolveControlUiSessionPrTarget(
        { ...selected, cfg },
        repository?.workspaceId === workspaceId &&
          repository?.agentId === selected.agentId &&
          repository.sessionKey === selected.canonicalKey
          ? repository
          : null,
      );
    };
    const target = current();
    if (!target) {
      return null;
    }
    retained = true;
    return {
      ...target,
      release: selected.release,
      assertCurrent() {
        if (current()?.identity !== target.identity) {
          throw new Error("Session pull-request target changed");
        }
      },
    };
  } finally {
    if (!retained) {
      selected.release();
    }
  }
}

type LoadSessionCheckDetails = (
  params: ControlUiSessionPullRequestChecksParams,
  deps: Omit<Parameters<typeof loadControlUiSessionPullRequestChecks>[1], "loadPullRequests"> & {
    read: ControlUiSessionPrReadContext;
  },
) => ReturnType<typeof loadControlUiSessionPullRequestChecks>;

const loadSessionCheckDetails: LoadSessionCheckDetails = async (params, deps) => {
  deps.assertCurrent();
  const { loadControlUiSessionPullRequestChecks } =
    await import("../control-ui-session-pr-check-details.js");
  const { loadControlUiSessionPullRequests } = await import("../control-ui-session-prs.js");
  return loadControlUiSessionPullRequestChecks(params, {
    ...deps,
    loadPullRequests: (request, options) =>
      loadControlUiSessionPullRequests(request, {
        ...options,
        read: deps.read,
      }),
  });
};

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = (...args) =>
    gitHubPublicApi.loadControlUiGitHubPreview(...args),
  loadChecks: LoadSessionCheckDetails = loadSessionCheckDetails,
): GatewayRequestHandlers {
  return {
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
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.linkPreview params"),
        );
        return;
      }
      const preview = await loadControlUiLinkPreview(url, isEnabled, scope);
      respond(true, !signal?.aborted && isEnabled() ? preview : {}, undefined);
    },
    "controlUi.githubPreview": createGitHubReadHandler(
      "controlUi.githubPreview",
      (params) => gitHubPublicApi.parseControlUiGitHubPreviewTarget(params),
      loadGitHubPreview,
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
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPreview params"),
        );
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
      let preparedSession: Awaited<ReturnType<typeof prepareCheckDetailsSession>> = null;
      try {
        const reader = client
          ? await prepareControlUiSessionPrRead({
              client,
              sessionKey: parsed.sessionKey,
              getRuntimeConfig: context.getRuntimeConfig,
              getSessionRowProjection: () => getSessionRowProjection(context),
              isCurrentClient: () =>
                !client.connId ||
                context
                  .getClientConnIds?.((candidate) => candidate === client)
                  .has(client.connId) === true,
            })
          : undefined;
        const binding = client
          ? ((await reader?.()) ?? null)
          : (preparedSession = await prepareCheckDetailsSession(parsed.sessionKey, context, () =>
              signal?.throwIfAborted(),
            ));
        if (!binding) {
          throw new gitHubPublicApi.ControlUiGitHubError(404, "Session CI details unavailable");
        }
        const assertCurrent = () => {
          let identityCurrent = false;
          try {
            binding.assertCurrent?.();
            identityCurrent = true;
          } catch {
            // The read owner reports retired selections and grants as assertion failures.
          }
          if (signal?.aborted || !identityCurrent) {
            throw new gitHubPublicApi.ControlUiGitHubError(
              409,
              "Session changed; reopen CI details",
            );
          }
        };
        await withControlUiSessionPrSource(
          binding.readSource,
          async (assertSourceCurrent, sourceIdentity) => {
            const assertReadCurrent = () => {
              assertSourceCurrent();
              assertCurrent();
            };
            const result = await loadChecks(
              { ...parsed, agentId: binding.params.agentId },
              {
                sessionScope: binding.identity,
                assertCurrent: assertReadCurrent,
                read: { target: binding, sourceIdentity, assertCurrent: assertReadCurrent },
              },
            );
            assertReadCurrent();
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
      } finally {
        preparedSession?.release();
      }
    },
    "controlUi.sessionPullRequests.subscribe": async ({ params, client, context, respond }) => {
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
      await new Promise<void>((resolve) => {
        const replacement = subscriptions.replace(
          connId,
          parsed.sessionKeys,
          parsed.refreshSessionKeys.length > 0 ? new Set(parsed.refreshSessionKeys) : undefined,
          resolve,
        );
        void replacement.catch(() => {});
      });
      respond(true, { subscribed: parsed.sessionKeys.length > 0 }, undefined);
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
