import { statSync } from "node:fs";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCatalogArchiveParams,
  validateSessionsCatalogContinueParams,
  validateSessionsCatalogImportParams,
  validateSessionsCatalogReadParams,
  validateSessionsCatalogStartTerminalParams,
  type SessionCatalogLocator,
} from "../../../packages/gateway-protocol/src/index.js";
import { allowsProcessHomeSessionScan } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { bindPluginSessionConversation } from "../../plugins/session-conversation-binding.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { recordSessionStateEventAsync } from "../../sessions/session-state-events.js";
import { upsertSessionUpstreamLinkAsync } from "../../sessions/session-upstream-links.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { copySessionCatalogToGateway } from "./session-catalog-gateway-copy.js";
import { importAuthorizedSessionCatalog } from "./session-catalog-import.js";
import { retireSessionCatalogLists } from "./session-catalog-list-operations.js";
import { listSessionCatalogHandler } from "./session-catalog-list.js";
import {
  allowProcessHomeFallback,
  catalogRegistrationSnapshot,
  createSessionCatalogRequestNodeSnapshot,
  listSessionCatalogProvider,
  resolveProviderCreateTarget,
} from "./session-catalog-provider-access.js";
import { readAuthorizedSessionCatalog } from "./session-catalog-read.js";
import { catalogError } from "./session-catalog-result.js";
import { resolveSessionCatalogThreadVisibility } from "./session-catalog-visibility.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export function resolveSessionCatalogProvider(
  catalogId: string,
): SessionCatalogProvider | undefined {
  return catalogRegistrationSnapshot().providers.find((candidate) => candidate.id === catalogId);
}

type SessionCatalogCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget & { pluginOwnerId: string } }
  | { ok: false; message: string; unknownCatalog?: true };

/** Resolves a catalog-owned create target at the start of sessions.create. */
export function resolveRegisteredCatalogCreateTarget(
  catalogId: string,
  agentId: string,
  config: OpenClawConfig,
): SessionCatalogCreateTargetResolution {
  const registration = catalogRegistrationSnapshot().registrations.find(
    (entry) => entry.provider.id === catalogId,
  );
  if (!registration) {
    return {
      ok: false,
      message: `unknown session catalog: ${catalogId}`,
      unknownCatalog: true,
    };
  }
  const resolved = resolveProviderCreateTarget(registration.provider, agentId, config);
  return resolved.ok
    ? { ok: true, target: { ...resolved.target, pluginOwnerId: registration.pluginId } }
    : resolved;
}

function registrationOrRespond(catalogId: string, respond: RespondFn) {
  const registration = catalogRegistrationSnapshot().registrations.find(
    (candidate) => candidate.provider.id === catalogId,
  );
  if (!registration) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${catalogId}`),
    );
  }
  return registration;
}

function respondCatalogError(error: unknown, respond: RespondFn): void {
  const details = catalogError(error);
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }));
}

async function authorizeSessionCatalogThread(params: {
  access: "read" | "mutate";
  client: GatewayClient | null;
  context: GatewayRequestContext;
  provider: SessionCatalogProvider;
  request: SessionCatalogLocator & { agentId?: string };
  respond: RespondFn;
}) {
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: params.request.agentId,
    respond: params.respond,
    cfg: params.context.getRuntimeConfig(),
  });
  if (!resolvedAgent) {
    return null;
  }
  const { agentId } = resolvedAgent;
  const allowHomeFallback = allowProcessHomeFallback(params.context.logGateway);
  const sourceVisibility = await resolveSessionCatalogThreadVisibility({
    access: params.access,
    allowProcessHomeFallback: allowHomeFallback,
    audience: params.provider.audience,
    client: params.client,
    context: params.context,
    fallbackAgentId: agentId,
    hostId: params.request.hostId,
    list: (request) => listSessionCatalogProvider(params.provider, { ...request, agentId }),
    listNodes: createSessionCatalogRequestNodeSnapshot(),
    ...(params.request.sourceHomeId ? { sourceHomeId: params.request.sourceHomeId } : {}),
    threadId: params.request.threadId,
  });
  if (sourceVisibility) {
    return { agentId, allowProcessHomeFallback: allowHomeFallback, sourceVisibility };
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "session catalog thread is not visible to this caller"),
  );
  return null;
}

export const sessionCatalogHandlers: GatewayRequestHandlers = {
  "sessions.catalog.list": listSessionCatalogHandler,

  "sessions.catalog.read": defineValidatedGatewayHandler(
    "sessions.catalog.read",
    validateSessionsCatalogReadParams,
    async ({ params: request, respond, context, client }) => {
      const provider = registrationOrRespond(request.catalogId, respond)?.provider;
      if (!provider) {
        return;
      }
      try {
        const authorization = await authorizeSessionCatalogThread({
          access: "read",
          request,
          provider,
          respond,
          context,
          client,
        });
        if (!authorization) {
          return;
        }
        const result = await readAuthorizedSessionCatalog({
          request,
          provider,
          ...authorization,
          client,
          context,
        });
        if (!result.ok) {
          respond(false, undefined, result.error);
          return;
        }
        respond(true, result.page);
      } catch (error) {
        respondCatalogError(error, respond);
      }
    },
  ),

  "sessions.catalog.continue": defineValidatedGatewayHandler(
    "sessions.catalog.continue",
    validateSessionsCatalogContinueParams,
    async ({ params: request, respond, client, context, sessionMutationCommitGuard, signal }) => {
      const registration = registrationOrRespond(request.catalogId, respond);
      if (!registration) {
        return;
      }
      const provider = registration.provider;
      if (!provider.continueSession && !provider.copyToGatewaySession) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog is view-only"));
        return;
      }
      try {
        const authorization = await authorizeSessionCatalogThread({
          access: "mutate",
          request,
          provider,
          respond,
          context,
          client,
        });
        if (!authorization) {
          return;
        }
        const creationError = authorizeGatewaySessionCreation({
          cfg: context.getRuntimeConfig(),
          client,
          agentId: authorization.agentId,
        });
        if (creationError) {
          respond(false, undefined, creationError);
          return;
        }
        const { catalogId: _catalogId, ...providerRequest } = request;
        // Fail closed for unscoped callers: providers gate high-authority
        // continues (e.g. node-executing bindings) on these scopes.
        const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
        const providerContinueParams = {
          ...providerRequest,
          agentId: authorization.agentId,
          allowProcessHomeFallback: authorization.allowProcessHomeFallback,
          clientScopes,
        };
        if (provider.copyToGatewaySession) {
          const copied = await copySessionCatalogToGateway({
            request,
            provider,
            providerContinueParams,
            agentId: authorization.agentId,
            clientScopes,
            client,
            context,
            commitGuard: sessionMutationCommitGuard,
            signal,
          });
          if (!copied.ok) {
            respond(false, undefined, copied.error);
          } else {
            respond(true, { sessionKey: copied.sessionKey });
          }
          return;
        }
        const continueSession = provider.continueSession;
        if (!continueSession) {
          throw new Error("catalog cannot continue this session");
        }
        const result = await continueSession(providerContinueParams);
        if (result.conversationBinding) {
          // operator.write on Continue is the approval boundary. Per-turn plugin and
          // node command authorization still applies after this binding is installed.
          await bindPluginSessionConversation({
            pluginId: registration.pluginId,
            pluginName: registration.pluginName,
            pluginRoot: registration.rootDir?.trim() || registration.source,
            sessionKey: result.sessionKey,
            binding: result.conversationBinding,
            afterBind: result.afterConversationBound,
          });
        }
        // Session creation canonicalizes the adopted key with its resolved agent,
        // including non-default agents. Use the returned key's owner for links and events.
        const agentId = resolveAgentIdFromSessionKey(result.sessionKey);
        if (result.upstream) {
          // Links exist only for adoptions made on this version: pre-upgrade adopted
          // sessions are transient linkage with no shipped contract, and re-continuing
          // from the catalog establishes the link. No doctor backfill by design.
          await upsertSessionUpstreamLinkAsync(
            {
              sessionKey: result.sessionKey,
              agentId,
              catalogId: request.catalogId,
              hostId: request.hostId,
              threadId: request.threadId,
              upstreamKind: result.upstream.kind,
              upstreamRef: result.upstream.ref,
              marker: result.upstream.marker,
            },
            { assertCommitAllowed: sessionMutationCommitGuard },
          );
        }
        await recordSessionStateEventAsync(
          {
            sessionKey: result.sessionKey,
            agentId,
            kind: "adopted",
            actorType: "human",
            dedupeKey: `adopted:${result.sessionKey}`,
            summary: `adopted from ${request.catalogId}`,
            payload: { catalogId: request.catalogId, hostId: request.hostId },
          },
          { assertCurrent: sessionMutationCommitGuard },
        );
        sessionMutationCommitGuard?.();
        respond(true, { sessionKey: result.sessionKey });
      } catch (error) {
        respondCatalogError(error, respond);
      }
    },
  ),

  "sessions.catalog.startTerminal": defineValidatedGatewayHandler(
    "sessions.catalog.startTerminal",
    validateSessionsCatalogStartTerminalParams,
    async (opts) => {
      const { params: request, respond, context } = opts;
      const config = context.getRuntimeConfig();
      if (config.gateway?.cliAgents?.enabled === false) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "CLI agent terminal start is disabled; enable gateway.cliAgents.enabled and retry",
          ),
        );
        return;
      }
      if (!context.isTerminalEnabled()) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "terminal is disabled; enable gateway.terminal.enabled and retry",
          ),
        );
        return;
      }
      if (!context.terminalSessions) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "terminal is not available; restart the Gateway with terminal support and retry",
          ),
        );
        return;
      }
      const provider = resolveSessionCatalogProvider(request.catalogId);
      if (!provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${request.catalogId}`),
        );
        return;
      }
      if (!provider.startTerminalSession) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "session catalog cannot start terminal sessions; choose a catalog that advertises startTerminal",
          ),
        );
        return;
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg: config,
        client: opts.client,
        agentId: request.agentId,
      });
      if (creationError) {
        respond(false, undefined, creationError);
        return;
      }
      let nodeId: string | undefined;
      if (request.hostId && !/^gateway:local(?::[^\s]+)?$/.test(request.hostId)) {
        nodeId = request.hostId.startsWith("node:")
          ? request.hostId.slice("node:".length).trim()
          : undefined;
        if (!nodeId || request.hostId !== `node:${nodeId}`) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              'invalid catalog host; choose "gateway:local" or a listed "node:<id>" host and retry',
            ),
          );
          return;
        }
      }
      if (!nodeId) {
        let cwdIsDirectory = false;
        try {
          cwdIsDirectory = path.isAbsolute(request.cwd) && statSync(request.cwd).isDirectory();
        } catch {
          // The caller owns worktree provisioning; missing/unreadable paths must not fall back home.
        }
        if (!cwdIsDirectory) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "cwd must be an existing absolute directory; create or choose a worktree and retry",
            ),
          );
          return;
        }
      }
      const startTerminalSession = provider.startTerminalSession;
      const { openTerminalSession, CATALOG_TERMINAL_INITIAL_SIZE } = await import("./terminal.js");
      await openTerminalSession(opts, {
        agentId: request.agentId,
        requireCliAgents: true,
        ...CATALOG_TERMINAL_INITIAL_SIZE,
        ...(!nodeId ? { requiredCwd: request.cwd } : {}),
        failureHint: "check the selected CLI, host, and terminal configuration, then retry",
        resolveCatalogPlan: async () => {
          const plan = await startTerminalSession.call(provider, {
            allowProcessHomeFallback: allowsProcessHomeSessionScan(),
            agentId: request.agentId,
            ...(request.hostId ? { hostId: request.hostId } : {}),
            cwd: request.cwd,
            ...(request.initialMessage !== undefined
              ? { initialMessage: request.initialMessage }
              : {}),
            ...(nodeId ? { nodeId } : {}),
          });
          if (plan.cwd !== request.cwd) {
            throw new Error(
              "session catalog did not preserve the requested cwd; choose the worktree again and retry",
            );
          }
          if (nodeId && (plan.kind !== "node" || plan.nodeId !== nodeId)) {
            throw new Error(
              "session catalog cannot start on the selected node; choose a supported host and retry",
            );
          }
          if (!nodeId && plan.kind !== "local") {
            throw new Error(
              'session catalog returned a remote plan for the local host; select its "node:<id>" host and retry',
            );
          }
          return plan;
        },
        catalogFailureMessage: "catalog terminal start failed",
      });
    },
  ),

  "sessions.catalog.import": defineValidatedGatewayHandler(
    "sessions.catalog.import",
    validateSessionsCatalogImportParams,
    async ({ params: request, respond, client, context, sessionMutationCommitGuard }) => {
      const provider = registrationOrRespond(request.catalogId, respond)?.provider;
      if (!provider) {
        return;
      }
      try {
        const authorize = () =>
          authorizeSessionCatalogThread({
            access: "read",
            request,
            provider,
            respond,
            context,
            client,
          });
        const authorization = await authorize();
        if (!authorization) {
          return;
        }
        const creationError = authorizeGatewaySessionCreation({
          cfg: context.getRuntimeConfig(),
          client,
          agentId: authorization.agentId,
        });
        if (creationError) {
          respond(false, undefined, creationError);
          return;
        }
        const imported = await importAuthorizedSessionCatalog({
          request,
          provider,
          ...authorization,
          client,
          context,
          reauthorize: async () => {
            const current = await authorize();
            if (!current) {
              return null;
            }
            if (
              current.agentId !== authorization.agentId ||
              current.allowProcessHomeFallback !== authorization.allowProcessHomeFallback
            ) {
              throw new Error("Session catalog source ownership changed; retry the import");
            }
            return current.sourceVisibility;
          },
          commitGuard: sessionMutationCommitGuard,
        });
        if (imported) {
          if (imported.ok) {
            respond(true, imported.result);
          } else {
            respond(false, undefined, imported.error);
          }
        }
      } catch (error) {
        respondCatalogError(error, respond);
      }
    },
  ),

  "sessions.catalog.archive": defineValidatedGatewayHandler(
    "sessions.catalog.archive",
    validateSessionsCatalogArchiveParams,
    async ({ params: request, respond, context, client }) => {
      const provider = registrationOrRespond(request.catalogId, respond)?.provider;
      if (!provider) {
        return;
      }
      if (!provider.archive) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog cannot archive"));
        return;
      }
      try {
        const authorization = await authorizeSessionCatalogThread({
          access: "mutate",
          request,
          provider,
          respond,
          context,
          client,
        });
        if (!authorization) {
          return;
        }
        const { catalogId: _catalogId, ...providerRequest } = request;
        const result = await provider.archive({
          ...providerRequest,
          agentId: authorization.agentId,
          allowProcessHomeFallback: authorization.allowProcessHomeFallback,
        });
        retireSessionCatalogLists(context.getRuntimeConfig());
        respond(true, result);
      } catch (error) {
        respondCatalogError(error, respond);
      }
    },
  ),
};
