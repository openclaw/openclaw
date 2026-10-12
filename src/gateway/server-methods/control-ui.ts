import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveConfiguredGitHubHost } from "../../agents/github-host.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../../agents/github-tool-identity.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
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
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { gitHubPublicApi, type ControlUiGitHubPreviewIdentity } from "../github-public-api.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
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
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    if (resolveConfiguredGitHubHost(current) !== "github.com") {
      return undefined;
    }
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
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
  assertActive();
  // Without a managed selection, retain service/env/anonymous access without
  // probing native gh. Both paths must still own the selection at delivery.
  const identity = configuredIdentity()
    ? await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        allowStale: true,
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

function createGitHubReadHandler<T>(
  method: string,
  parseTarget: (params: unknown) => T | null,
  load: (
    target: T,
    identity?: ControlUiGitHubPreviewIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
  ) => Promise<unknown>,
): GatewayRequestHandlers[string] {
  return async (options) => {
    const { params, respond, context } = options;
    const target = parseTarget(params);
    if (!target || (params.refresh !== undefined && typeof params.refresh !== "boolean")) {
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
    try {
      const { identity, assertSelected } = await prepareControlUiGitHubIdentity(
        options,
        resolved.agentId,
      );
      assertSelected();
      const result =
        params.refresh === true
          ? await load(target, identity, undefined, true)
          : await load(target, identity);
      assertSelected();
      respond(true, result, undefined);
    } catch (error) {
      const { message, ...details } =
        error instanceof GitHubReadRequestInactiveError
          ? { message: error.message, retryable: true }
          : error instanceof GitHubIdentityError
            ? { message: error.message, retryable: error.reason !== "unavailable" }
            : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
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
  client: GatewayClient | null,
): Promise<ControlUiSessionPrTarget | null> {
  const sourceCfg = context.getRuntimeConfig();
  const sourceRequest = resolveRequestedGlobalAgentId(sourceCfg, sessionKey);
  if (!sourceRequest.ok) {
    return null;
  }
  const binding = captureIncognitoSessionSource({ sessionKey, agentId: sourceRequest.agentId });
  if (binding && "kind" in binding) {
    binding.assertCurrent();
    return null;
  }
  const claim = binding?.actor.sessions.captureCurrent(sessionKey);
  const assertRoutingCurrent = captureSessionMutationRouting(sourceCfg);
  const preparedEntry =
    binding &&
    (await binding.actor.sessions.read(
      {
        assertCurrent() {
          binding.admissionSignal?.throwIfAborted();
          claim?.assertCurrent();
          assertRoutingCurrent(context.getRuntimeConfig());
        },
      },
      { sessionKey },
      binding.admissionSignal,
    ));
  preparedEntry?.snapshot.assertCurrent();
  const preparedMedia = binding?.actor.sessions.readMedia(sessionKey);
  const readSelected = () => {
    const cfg = context.getRuntimeConfig();
    const requested = resolveRequestedGlobalAgentId(cfg, sessionKey);
    if (!requested.ok) {
      return undefined;
    }
    if (binding) {
      binding.admissionSignal?.throwIfAborted();
      claim?.assertCurrent();
      assertRoutingCurrent(cfg);
      const entry = preparedEntry?.entry && {
        ...preparedEntry.entry,
        pendingWorktree: preparedMedia?.pendingWorktree,
        pendingProjectGitUrl: preparedMedia?.pendingProjectGitUrl,
      };
      const sharing = binding.actor.sessions.readSharing(sessionKey)?.entry;
      const media = binding.actor.sessions.readMedia(sessionKey);
      const entryFilter = createSessionListEntryFilter({ client, cfg });
      if (
        !entry ||
        !sharing ||
        !media ||
        requested.agentId !== binding.actor.agentId ||
        sharing.sessionId !== entry.sessionId ||
        sharing.lifecycleRevision !== entry.lifecycleRevision ||
        media.repositoryWorkspaceId !== entry.repositoryWorkspaceId ||
        media.worktreeId !== entry.worktree?.id ||
        media.spawnedCwd !== entry.spawnedCwd ||
        media.spawnedWorkspaceDir !== entry.spawnedWorkspaceDir ||
        !isDeepStrictEqual(media.pendingWorktree, entry.pendingWorktree) ||
        media.pendingProjectGitUrl !== entry.pendingProjectGitUrl ||
        (entryFilter && !entryFilter(sessionKey, sharing))
      ) {
        return undefined;
      }
      return {
        cfg,
        agentId: binding.actor.agentId,
        canonicalKey: sessionKey,
        storePath: binding.actor.path,
        readSource: {
          agentId: binding.actor.agentId,
          path: binding.actor.path,
          databaseIdentity: binding.actor.identity.incarnation,
        },
        entry,
      };
    }
    const { target, entry, storePath } = loadAccessorSessionEntryForGatewayTarget({
      key: sessionKey,
      cfg,
      clone: false,
      agentId: requested.agentId,
    });
    const entryFilter = createSessionListEntryFilter({ client, cfg });
    if (!entry?.sessionId || (entryFilter && !entryFilter(target.canonicalKey, entry))) {
      return undefined;
    }
    return {
      cfg,
      agentId: target.agentId,
      canonicalKey: target.canonicalKey,
      storePath,
      readSource: target.readSource,
      entry,
    };
  };
  const initial = readSelected();
  if (!initial) {
    return null;
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  const prepared = workspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
    : undefined;
  const current = () => {
    const selected = readSelected();
    if (
      !selected ||
      selected.entry.sessionId !== initial.entry.sessionId ||
      selected.entry.lifecycleRevision !== initial.entry.lifecycleRevision ||
      selected.entry.repositoryWorkspaceId !== workspaceId
    ) {
      return undefined;
    }
    const repository = prepared?.current();
    return resolveControlUiSessionPrTarget(
      selected,
      repository?.workspaceId === workspaceId &&
        repository?.agentId === selected.agentId &&
        repository.sessionKey === selected.canonicalKey
        ? repository
        : null,
    );
  };
  const target = current();
  return target
    ? {
        ...target,
        assertCurrent() {
          if (current()?.identity !== target.identity) {
            throw new Error("Session pull-request target changed");
          }
        },
      }
    : null;
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
    ),
    "controlUi.githubDetail": createGitHubReadHandler(
      "controlUi.githubDetail",
      (params) => gitHubPublicApi.parseGitHubTarget(params),
      (...args) => gitHubPublicApi.loadGitHubDetail(...args),
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
          : await prepareCheckDetailsSession(parsed.sessionKey, context, client);
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
