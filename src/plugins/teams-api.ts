import type {
  GatewayAuthorizationContext,
  GatewayResourceRef,
} from "../gateway/authorization/contracts.js";
import {
  getGatewayAuthorizationContext,
  isGatewayAuthorizationContextActive,
} from "../gateway/authorization/request-context.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type {
  OpenClawPluginTeamsApi,
  OpenClawPluginTeamsRequestContext,
  OpenClawPluginTeamsResourceRef,
} from "./teams-types.js";

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function normalizeResource(resource: OpenClawPluginTeamsResourceRef): GatewayResourceRef {
  return Object.freeze({
    namespace: requiredIdentifier(resource.namespace, "resource namespace"),
    type: requiredIdentifier(resource.type, "resource type"),
    id: requiredIdentifier(resource.id, "resource id"),
  });
}

function sameResource(first: GatewayResourceRef, second: GatewayResourceRef): boolean {
  return (
    first.namespace === second.namespace && first.type === second.type && first.id === second.id
  );
}

function requirePluginResourceNamespace(resource: GatewayResourceRef, pluginId: string): void {
  if (resource.namespace !== pluginId) {
    throw new Error("Teams resources must use the loader-bound plugin namespace");
  }
}

export function createPluginTeamsApi(input: {
  pluginId: string;
  database?: OpenClawStateDatabaseOptions;
}): OpenClawPluginTeamsApi {
  const pluginId = requiredIdentifier(input.pluginId, "plugin id");
  const operationScope = `plugin:${pluginId}`;
  const trustedContexts = new WeakMap<object, GatewayAuthorizationContext>();

  const requireTrustedContext = (
    context: OpenClawPluginTeamsRequestContext,
  ): GatewayAuthorizationContext => {
    const trusted = trustedContexts.get(context);
    if (
      !trusted ||
      getGatewayAuthorizationContext() !== trusted ||
      !isGatewayAuthorizationContextActive(trusted)
    ) {
      throw new Error("an active trusted Teams request context is required");
    }
    return trusted;
  };

  const requireAuthorizedAction = (
    trusted: GatewayAuthorizationContext,
    requiredAction: string,
    resource: GatewayResourceRef,
  ): void => {
    const action = requiredIdentifier(requiredAction, "required Teams action");
    if (
      trusted.permission !== action ||
      !trusted.resources.some((entry) => sameResource(entry, resource))
    ) {
      throw new Error("the trusted Teams request was not authorized for the required action");
    }
  };

  const contextApi: OpenClawPluginTeamsApi["context"] = {
    require: () => {
      const trusted = getGatewayAuthorizationContext();
      if (!trusted || !trusted.requestId || !isGatewayAuthorizationContextActive(trusted)) {
        throw new Error("an active trusted gateway authorization context is required");
      }
      if (trusted.pluginId !== pluginId) {
        throw new Error("the trusted Teams request belongs to a different plugin");
      }
      if (
        trusted.resources.length === 0 ||
        trusted.resources.some((resource) => resource.namespace !== pluginId)
      ) {
        throw new Error("Teams authorization must use the loader-bound plugin namespace");
      }
      if (trusted.principalKind !== "human" && trusted.principalKind !== "service") {
        throw new Error("Teams requests require a human or delegated agent principal");
      }
      if (trusted.principalKind === "service" && !trusted.delegation) {
        throw new Error("Teams agent requests require a server-attested delegation");
      }
      const context: OpenClawPluginTeamsRequestContext = Object.freeze({
        isolationDomainId: trusted.domain.id,
        principal: Object.freeze({
          id: trusted.principalId,
          kind: trusted.principalKind === "human" ? "human" : "agent",
        }),
        ...(trusted.delegation
          ? {
              delegatedSession: Object.freeze({
                id: trusted.delegation.id,
                assignmentId: trusted.delegation.assignmentId,
                sponsorPrincipalId: trusted.delegation.sponsorPrincipalId,
              }),
            }
          : {}),
        requestId: trusted.requestId,
      });
      trustedContexts.set(context, trusted);
      return context;
    },
  };

  return {
    context: contextApi,
    resources: {
      prepareRegister: async ({
        context,
        resource: rawResource,
        parent: rawParent,
        requiredAction,
        idempotencyKey,
      }) => {
        const trusted = requireTrustedContext(context);
        const resource = normalizeResource(rawResource);
        const parent = rawParent ? normalizeResource(rawParent) : undefined;
        requirePluginResourceNamespace(resource, pluginId);
        if (parent) {
          requirePluginResourceNamespace(parent, pluginId);
        }
        requireAuthorizedAction(trusted, requiredAction, parent ?? resource);
        const { prepareAuthorizationResourceRegistration } =
          await import("../gateway/authorization/resource-operations.js");
        requireTrustedContext(context);
        const prepared = prepareAuthorizationResourceRegistration({
          operationScope,
          idempotencyKey,
          domainId: trusted.domain.id,
          resource,
          ...(parent ? { parent } : {}),
          actor:
            trusted.principalKind === "human"
              ? { kind: "human", principalId: trusted.principalId }
              : {
                  kind: "delegated-agent",
                  principalId: trusted.principalId,
                  sponsorPrincipalId: trusted.delegation!.sponsorPrincipalId,
                  delegationId: trusted.delegation!.id,
                  assignmentId: trusted.delegation!.assignmentId,
                },
          database: input.database,
        });
        return prepared.operationId;
      },
      prepareRetire: async ({ context, resource: rawResource, requiredAction, idempotencyKey }) => {
        const trusted = requireTrustedContext(context);
        const resource = normalizeResource(rawResource);
        requirePluginResourceNamespace(resource, pluginId);
        requireAuthorizedAction(trusted, requiredAction, resource);
        const { prepareAuthorizationResourceRetirement } =
          await import("../gateway/authorization/resource-operations.js");
        requireTrustedContext(context);
        const prepared = prepareAuthorizationResourceRetirement({
          operationScope,
          idempotencyKey,
          domainId: trusted.domain.id,
          resource,
          actorPrincipalId: trusted.principalId,
          database: input.database,
        });
        return prepared.operationId;
      },
      replayPrepared: async ({ operation }) => {
        const operationId = requiredIdentifier(operation, "authorization operation");
        const { replayAuthorizationResourceOperationForHost } =
          await import("../gateway/authorization/resource-operations.js");
        replayAuthorizationResourceOperationForHost({
          operationScope,
          operationId,
          database: input.database,
        });
      },
      owner: async ({ context, resource: rawResource }) => {
        const trusted = requireTrustedContext(context);
        const resource = normalizeResource(rawResource);
        requirePluginResourceNamespace(resource, pluginId);
        if (!trusted.resources.some((entry) => sameResource(entry, resource))) {
          throw new Error("the trusted Teams request was not authorized for this resource");
        }
        const { getAuthorizationResourceOwner } =
          await import("../gateway/authorization/resource-operations.js");
        requireTrustedContext(context);
        const owner = getAuthorizationResourceOwner({
          domainId: trusted.domain.id,
          resource,
          database: input.database,
        });
        if (!owner) {
          throw new Error("authorization resource owner is unavailable");
        }
        return owner;
      },
    },
  };
}
