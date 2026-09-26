import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalogLocator,
  validateSessionsCatalogArchiveParams,
  validateSessionsCatalogContinueParams,
  validateSessionsCatalogReadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { authorizeSessionCatalogThread } from "./session-catalog-authorization.js";
import { continueAuthorizedSessionCatalog } from "./session-catalog-continue.js";
import { retireSessionCatalogLists } from "./session-catalog-list-operations.js";
import { listSessionCatalogHandler } from "./session-catalog-list.js";
import {
  catalogRegistrationSnapshot,
  resolveProviderCreateTarget,
} from "./session-catalog-provider-access.js";
import { readAuthorizedSessionCatalog } from "./session-catalog-read.js";
import { catalogError } from "./session-catalog-result.js";
import { catalogStartHandler } from "./session-catalog-terminal-start.js";
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

async function authorizeCatalogRequest(params: {
  access: "read" | "mutate";
  request: SessionCatalogLocator & { agentId?: string };
  provider: SessionCatalogProvider;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<{ agentId: string; allowProcessHomeFallback: boolean } | null> {
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: params.request.agentId,
    respond: params.respond,
    cfg: params.context.getRuntimeConfig(),
    normalize: normalizeOptionalString,
  });
  if (!resolvedAgent) {
    return null;
  }
  const authorization = await authorizeSessionCatalogThread({
    access: params.access,
    agentId: resolvedAgent.agentId,
    client: params.client,
    context: params.context,
    provider: params.provider,
    request: params.request,
    respond: params.respond,
  });
  return authorization ? { agentId: resolvedAgent.agentId, ...authorization } : null;
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
        const authorization = await authorizeCatalogRequest({
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
    async ({ params: request, respond, client, context, sessionMutationCommitGuard }) => {
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
        const authorization = await authorizeCatalogRequest({
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
        const continued = await continueAuthorizedSessionCatalog({
          request,
          registration,
          agentId: authorization.agentId,
          allowProcessHomeFallback: authorization.allowProcessHomeFallback,
          client,
          context,
          commitGuard: sessionMutationCommitGuard,
        });
        if (!continued.ok) {
          respond(false, undefined, continued.error);
          return;
        }
        respond(true, { sessionKey: continued.sessionKey });
      } catch (error) {
        respondCatalogError(error, respond);
      }
    },
  ),

  "sessions.catalog.startTerminal": catalogStartHandler(resolveSessionCatalogProvider),

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
        const authorization = await authorizeCatalogRequest({
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
