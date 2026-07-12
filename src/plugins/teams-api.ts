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
  OpenClawPluginTeamsToolCallContext,
} from "./teams-types.js";
import {
  hasPluginToolAuthorizationSubject,
  requireCurrentPluginToolAuthorizationInvocation,
  requirePluginToolAuthorizationInvocation,
  type PluginToolAuthorizationInvocation,
} from "./tool-authorization-context.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

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
  const trustedContexts = new WeakMap<
    object,
    | { kind: "gateway"; authorization: GatewayAuthorizationContext }
    | {
        kind: "tool";
        authorization: GatewayAuthorizationContext;
        invocation: PluginToolAuthorizationInvocation;
      }
  >();
  const trustedToolCalls = new WeakMap<
    OpenClawPluginTeamsToolCallContext,
    PluginToolAuthorizationInvocation
  >();

  const requireTrustedContext = (
    context: OpenClawPluginTeamsRequestContext,
  ): GatewayAuthorizationContext => {
    const binding = trustedContexts.get(context);
    if (!binding) {
      throw new Error("an active trusted Teams request context is required");
    }
    if (binding.kind === "tool") {
      requireCurrentPluginToolAuthorizationInvocation(binding.invocation);
      return binding.authorization;
    }
    if (
      getGatewayAuthorizationContext() !== binding.authorization ||
      !isGatewayAuthorizationContextActive(binding.authorization)
    ) {
      throw new Error("an active trusted Teams request context is required");
    }
    return binding.authorization;
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

  const projectRequestContext = (
    trusted: GatewayAuthorizationContext,
  ): OpenClawPluginTeamsRequestContext =>
    Object.freeze({
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
      requestId: trusted.requestId!,
    });

  const requireContext = ((toolContext?: OpenClawPluginToolContext) => {
    if (toolContext) {
      const invocation = requirePluginToolAuthorizationInvocation({
        pluginId,
        context: toolContext,
      });
      const context: OpenClawPluginTeamsToolCallContext = Object.freeze({
        callId: invocation.toolCallId,
      });
      trustedToolCalls.set(context, invocation);
      return context;
    }
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
    const context = projectRequestContext(trusted);
    trustedContexts.set(context, { kind: "gateway", authorization: trusted });
    return context;
  }) as OpenClawPluginTeamsApi["context"]["require"];

  const contextApi: OpenClawPluginTeamsApi["context"] = {
    isBound: hasPluginToolAuthorizationSubject,
    require: requireContext,
  };

  return {
    context: contextApi,
    authorization: {
      decide: async ({ context, permission: rawPermission, resources: rawResources }) => {
        const invocation = trustedToolCalls.get(context as OpenClawPluginTeamsToolCallContext);
        const gatewayContext = invocation
          ? undefined
          : requireTrustedContext(context as OpenClawPluginTeamsRequestContext);
        if (invocation) {
          if (
            invocation.toolCallId !== (context as OpenClawPluginTeamsToolCallContext).callId ||
            !invocation.subject
          ) {
            throw new Error("an active trusted Teams tool call context is required");
          }
          requireCurrentPluginToolAuthorizationInvocation(invocation);
        }
        const permission = requiredIdentifier(rawPermission, "Teams permission");
        if (!Array.isArray(rawResources) || rawResources.length === 0) {
          throw new Error("Teams authorization requires at least one resource");
        }
        const resources = Object.freeze(
          rawResources.map((rawResource) => {
            const resource = normalizeResource(rawResource);
            requirePluginResourceNamespace(resource, pluginId);
            return resource;
          }),
        );
        const [{ authorizeGatewayAccess }, { createStateGatewayAuthorizationRuntime }] =
          await Promise.all([
            import("../gateway/authorization/kernel.js"),
            import("../gateway/authorization/state-provider.js"),
          ]);
        let principal;
        let domain;
        let delegation;
        let agentSession;
        let requestId;
        if (invocation) {
          requireCurrentPluginToolAuthorizationInvocation(invocation);
          principal = invocation.subject!.principal;
          domain = invocation.subject!.domain;
          delegation = invocation.subject!.delegation;
          agentSession = invocation.subject!.agentSession;
          requestId = invocation.toolCallId;
        } else {
          requireTrustedContext(context as OpenClawPluginTeamsRequestContext);
          const { getAuthorizationPrincipalById } =
            await import("../gateway/authorization/state-store.js");
          requireTrustedContext(context as OpenClawPluginTeamsRequestContext);
          principal = getAuthorizationPrincipalById({
            id: gatewayContext!.principalId,
            database: input.database,
          });
          if (!principal || principal.kind !== gatewayContext!.principalKind) {
            throw new Error("the trusted Teams request principal is unavailable");
          }
          domain = gatewayContext!.domain;
          delegation = gatewayContext!.delegation;
          requestId = gatewayContext!.requestId!;
        }
        const outcome = await authorizeGatewayAccess({
          runtime: createStateGatewayAuthorizationRuntime({ database: input.database }),
          policy: { kind: "resource", permission, resolveResources: () => resources },
          principal,
          domain,
          ...(delegation ? { delegation } : {}),
          ...(agentSession ? { agentSession } : {}),
          method: invocation
            ? `plugin-tool:${pluginId}:${invocation.toolName}`
            : `plugin-capability:${pluginId}`,
          params: undefined,
          getConfig: () => ({}),
        });
        if (invocation) {
          requireCurrentPluginToolAuthorizationInvocation(invocation);
        } else {
          requireTrustedContext(context as OpenClawPluginTeamsRequestContext);
        }
        if (!outcome.allowed || !outcome.security) {
          return { allowed: false };
        }
        const trusted = Object.freeze({
          ...outcome.security,
          pluginId,
          requestId,
        });
        const requestContext = projectRequestContext(trusted);
        trustedContexts.set(
          requestContext,
          invocation
            ? { kind: "tool", authorization: trusted, invocation }
            : { kind: "gateway", authorization: trusted },
        );
        return { allowed: true, context: requestContext };
      },
    },
    resources: {
      listChildren: async ({ context, parent: rawParent, requiredAction, type }) => {
        const trusted = requireTrustedContext(context);
        const parent = normalizeResource(rawParent);
        requirePluginResourceNamespace(parent, pluginId);
        requireAuthorizedAction(trusted, requiredAction, parent);
        const { listAuthorizationResourceChildren } =
          await import("../gateway/authorization/resource-operations.js");
        requireTrustedContext(context);
        return listAuthorizationResourceChildren({
          domainId: trusted.domain.id,
          parent,
          ...(type ? { type: requiredIdentifier(type, "resource child type") } : {}),
          database: input.database,
        });
      },
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
      prepareRetire: async ({
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
        const { prepareAuthorizationResourceRetirement } =
          await import("../gateway/authorization/resource-operations.js");
        requireTrustedContext(context);
        const prepared = prepareAuthorizationResourceRetirement({
          operationScope,
          idempotencyKey,
          domainId: trusted.domain.id,
          resource,
          ...(parent ? { parent } : {}),
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
