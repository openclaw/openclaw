import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { roleClient } from "./session-sharing.test-utils.js";

// Team incidents R11/R12: "message failed" / "github_publish failed: missing scope: operator.write".
// The agent tool reaches the Gateway through the in-process bridge with the turn grant's scopes,
// for a Control UI turn (the person's socket is the request scope) and a channel turn (no socket).
// The Gateway method then decides from that grant: these write actions reach owner and admin, and
// a member's refusal names the tool and the next step instead of a scope id.
const ROLE_SCOPES = {
  owner: ["operator.admin"],
  admin: ["operator.admin"],
  member: ["operator.read", "operator.sessions.write"],
} as const;
type Principal = keyof typeof ROLE_SCOPES;
const TOOLS = [
  ["message", "message.action", { action: "channel-info", channel: "discord" }],
  ["github_publish", "sessions.github.action", { action: "inspect", sessionKey: "agent:main:x" }],
  ["github_publish", "sessions.github.action", { action: "merge", sessionKey: "agent:main:x" }],
] as const;
const CELLS = (Object.keys(ROLE_SCOPES) as Principal[]).flatMap((principal) =>
  (["control-ui", "channel"] as const).flatMap((entry) =>
    TOOLS.map(
      ([toolName, method, params]) => [principal, entry, toolName, method, params] as const,
    ),
  ),
);

describe("agent tools reach the Gateway with the turn grant", () => {
  it.each(CELLS)("%s x %s x %s %s %j", async (principal, entry, toolName, method, params) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
        respond(true, { reached: true }),
      );
      const cfg: OpenClawConfig = {
        session: { store: state.path("sessions.json") },
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        gateway: {
          roles: {
            default: "member",
            definitions: {
              admin: { sessions: { others: "write" }, agents: "*", scopes: [...ROLE_SCOPES.admin] },
              member: {
                sessions: { others: "view" },
                agents: "*",
                scopes: [...ROLE_SCOPES.member],
              },
            },
          },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.resolveGatewayContext = () => context;
      // The real core descriptors decide each method's scope; only the handlers are stubs.
      const registry = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors({
          "message.action": handler,
          "sessions.github.action": handler,
        }),
      );
      context.getGatewayMethodRegistry = () => registry;
      let client: GatewayClient;
      if (principal === "owner") {
        // The owner signs in with the shared token: a System-actor socket on the owner profile.
        const owner = createOperatorWsClient({
          connId: "bridge-owner",
          scopes: ["operator.admin"],
        });
        ensureGatewayOwnerProfile(null);
        owner.authenticatedUserProfile = {
          profileId: GATEWAY_OWNER_PROFILE_ID,
          displayName: null,
          avatarRevision: "fixture",
          hasAvatar: false,
          updatedAt: 1,
        };
        owner.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
        prepareGatewayConnectOperatorAccess(owner);
        client = owner;
      } else {
        client = roleClient(principal as never, `bridge-${principal}`);
        client.connect.scopes = [...ROLE_SCOPES[principal]];
      }
      const prepared = await prepareGatewayOperatorRunAuthority({ client, context });
      const [tool] = toToolDefinitions([
        {
          name: toolName,
          label: toolName,
          description: "bridge probe",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [],
            details: await callInProcessGatewayTool(method, { ...params }),
          }),
        },
      ]);
      const run = () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:x",
            operatorAuthority: prepared?.authority,
            gatewayContextResolver: () => context,
          },
          () => tool!.execute("bridge", {}, undefined, undefined, {} as never),
        );
      try {
        const result =
          entry === "control-ui"
            ? await withPluginRuntimeGatewayRequestScope(
                {
                  client,
                  context,
                  resolveGatewayContext: () => context,
                  isWebchatConnect: () => false,
                },
                run,
              )
            : await run();
        expect(prepared?.authority.scopes).toEqual(ROLE_SCOPES[principal]);
        expect(result.details).toEqual(
          principal === "member"
            ? {
                status: "error",
                tool: toolName,
                error: `Your role on this Gateway does not allow this ${toolName} action. Ask a Gateway admin to do it, or to add the permission to your role. Do not retry.`,
              }
            : { reached: true },
        );
      } finally {
        prepared?.release();
      }
    });
  });
});
