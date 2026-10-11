import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { MCP_EVENTS_PROTOCOL_VERSION, requestMcpEvent } from "../../agents/mcp-event-request.js";
import {
  prepareMcpEventConnection,
  type McpEventPrincipal,
} from "../../plugins/service-mcp-events.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import { readCronCallerScope } from "./cron-caller-scope.js";
import type { GatewayRequestHandlers } from "./types.js";

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

/** One bounded page, with an explicit cursor; never traverse unbounded remote catalogs. */
function projectCatalog(value: unknown) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    value.events.length > 1000 ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576 ||
    (value.nextCursor !== undefined && !boundedString(value.nextCursor, 16_384))
  ) {
    throw new Error("Invalid MCP Events catalog response.");
  }
  const events = value.events.map((event: unknown) => {
    if (
      !isRecord(event) ||
      !boundedString(event.name, 256) ||
      !Array.isArray(event.delivery) ||
      !event.delivery.every((mode: unknown) => typeof mode === "string") ||
      !(isRecord(event.inputSchema) || typeof event.inputSchema === "boolean") ||
      !(isRecord(event.payloadSchema) || typeof event.payloadSchema === "boolean")
    ) {
      throw new Error("Invalid MCP Events catalog definition.");
    }
    return {
      name: event.name,
      ...(typeof event.description === "string"
        ? { description: event.description.slice(0, 4096) }
        : {}),
      delivery: event.delivery,
      inputSchema: event.inputSchema,
      payloadSchema: event.payloadSchema,
    };
  });
  return {
    events: events.filter((event) => event.delivery.includes("webhook")),
    ...(value.nextCursor !== undefined ? { nextCursor: value.nextCursor } : {}),
  };
}

export const mcpEventsHandlers: GatewayRequestHandlers = {
  "mcp.events.list": async (options) => {
    const { params, client, context, respond, signal, hasCurrentClientAuthority } = options;
    if (
      Object.keys(params).some((key) => !["agentId", "serverName", "cursor"].includes(key)) ||
      !boundedString(params.serverName, 256) ||
      (params.agentId !== undefined && !boundedString(params.agentId, 128)) ||
      (params.cursor !== undefined && !boundedString(params.cursor, 16_384))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Expected {agentId?, serverName, cursor?}."),
      );
      return;
    }
    const serverName = params.serverName;
    const cursor = params.cursor;
    const cfg = context.getRuntimeConfig();
    const registry = context.getGatewayMethodRegistry?.();
    if (
      !registry
        ?.descriptors()
        .some((entry) => entry.owner.kind === "plugin" && entry.owner.pluginId === "mcp-events")
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Enable the MCP Events plugin to browse event sources."),
      );
      return;
    }
    const caller = readCronCallerScope(client);
    const resolved = resolveAgentIdOrRespondError({
      cfg,
      respond,
      rawAgentId: params.agentId ?? caller?.agentId,
    });
    if (!resolved) {
      return;
    }
    if (caller && caller.agentId !== resolved.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "MCP Events catalog is bound to the caller's agent."),
      );
      return;
    }
    const requester = caller?.toolsAllowProvenance?.channelRequester;
    const principal: McpEventPrincipal = {
      agentId: resolved.agentId,
      ...(caller
        ? {
            sessionKey: caller.sessionKey,
            account: {
              id: caller.accountId,
              channel:
                caller.toolsAllowProvenance?.callerOrigin?.kind === "external"
                  ? caller.toolsAllowProvenance.callerOrigin.channel
                  : undefined,
            },
          }
        : {}),
      ...(requester
        ? {
            requester: {
              requesterSenderId: requester.senderId,
              messageChannel: requester.channel,
              agentAccountId: requester.accountId,
            },
          }
        : {}),
    };
    // UI callers without native channel provenance may browse shared connectors,
    // but never borrow another user's requester-scoped OAuth/resolver connection.
    const identity = {
      user: client?.authenticatedUserId,
      profile: client?.authenticatedUserProfile?.profileId,
      runtime: client?.internal?.agentRuntimeIdentity,
    };
    const assertCurrent = () => {
      signal?.throwIfAborted();
      client?.connectionSignal?.throwIfAborted();
      options.sessionMutationCommitGuard?.();
      if (
        !client ||
        client.invalidated ||
        hasCurrentClientAuthority?.() === false ||
        !operatorScopeSatisfied("operator.read", client.connect.scopes ?? []) ||
        context.getRuntimeConfig() !== cfg ||
        context.getGatewayMethodRegistry?.() !== registry ||
        client.authenticatedUserId !== identity.user ||
        client.authenticatedUserProfile?.profileId !== identity.profile ||
        client.internal?.agentRuntimeIdentity !== identity.runtime ||
        !isDeepStrictEqual(readCronCallerScope(client), caller)
      ) {
        throw new Error("MCP Events catalog caller authority changed.");
      }
      assertActiveAgentRuntimeAuthority(client, context);
    };
    try {
      assertCurrent();
      const connection = await prepareMcpEventConnection({
        cfg,
        principal,
        serverName,
        assertCurrent,
      });
      try {
        const discovered = await requestMcpEvent({
          ...connection,
          serverName,
          method: "server/discover",
          signal,
          assertCurrent: connection.assertCurrent,
        });
        connection.assertCurrent();
        if (
          !isRecord(discovered) ||
          !Array.isArray(discovered.supportedVersions) ||
          !discovered.supportedVersions.includes(MCP_EVENTS_PROTOCOL_VERSION) ||
          !isRecord(discovered.capabilities) ||
          !Object.hasOwn(discovered.capabilities, "events")
        ) {
          throw new Error("This MCP server does not advertise the supported Events protocol.");
        }
        const result = projectCatalog(
          await requestMcpEvent({
            ...connection,
            serverName,
            method: "events/list",
            params: typeof cursor === "string" ? { cursor } : {},
            signal,
            assertCurrent: connection.assertCurrent,
          }),
        );
        connection.assertCurrent();
        respond(true, { serverName, ...result }, undefined);
      } finally {
        connection.release();
      }
    } catch {
      // Resolver URLs, auth headers, and remote diagnostic bodies are not catalog data.
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "MCP event catalog unavailable. Check the server's Events support, your account connection, and current access.",
        ),
      );
    }
  },
};
