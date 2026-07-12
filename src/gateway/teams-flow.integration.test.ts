import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  bindGatewayClientAuthorizationDomain,
  bindGatewayClientTeamsSession,
} from "./authorization/client-domain.js";
import { bindAuthorizationResource } from "./authorization/state-store.js";
import { bootstrapTeamsOwner } from "./authorization/teams-bootstrap.js";
import { revokeTeamsSession } from "./authorization/teams-identity.js";
import {
  createTeamsInvite,
  registerTeamsLocalAccountFromInvite,
} from "./authorization/teams-invites.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestHandler } from "./server-methods/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => cleanupTempDirs(tempDirs));

describe("Teams owner-to-member authorization flow", () => {
  it("bootstraps, invites, dispatches one exact tab, and invalidates the open client on logout", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "openclaw-teams-flow-"));
    const owner = await bootstrapTeamsOwner({
      loginLabel: "owner@example.com",
      password: "correct horse battery staple",
      domainId: "domain-1",
    });
    const workspace = { namespace: "workspaces", type: "workspace", id: "default" } as const;
    const sharedTab = { namespace: "workspaces", type: "tab", id: "main" } as const;
    const privateTab = { namespace: "workspaces", type: "tab", id: "private" } as const;
    bindAuthorizationResource({
      domainId: owner.domainId,
      resource: privateTab,
      parent: workspace,
      ownerPrincipalId: owner.account.principalId,
    });
    const invite = createTeamsInvite({
      domainId: owner.domainId,
      createdByPrincipalId: owner.account.principalId,
      ttlMs: 60_000,
      grants: [{ resource: sharedTab, permission: "workspaces.tab.read" }],
    });
    const registered = await registerTeamsLocalAccountFromInvite({
      code: invite.code,
      loginLabel: "member@example.com",
      password: "another correct horse battery staple",
      sessionTtlMs: 60_000,
    });
    const session = registered.session.session;
    const client: GatewayClient = {
      connId: "member-conn",
      connect: {
        role: "member",
        scopes: [],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "1", platform: "test", mode: "ui" },
      },
      principal: session.principal,
    };
    bindGatewayClientAuthorizationDomain(client, { id: session.domainId });
    bindGatewayClientTeamsSession(client, {
      id: session.id,
      principalId: session.principalId,
      domainId: session.domainId,
    });
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const registry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "workspaces",
        name: "workspaces.tab.get",
        handler,
        scope: "operator.read",
        access: {
          kind: "resource",
          member: true,
          permission: "workspaces.tab.read",
          resolveResources: ({ params }) => [
            { namespace: "workspaces", type: "tab", id: (params as { id: string }).id },
          ],
        },
      }),
    ]);
    const dispatch = async (id: string) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: `request-${id}`, method: "workspaces.tab.get", params: { id } },
        respond,
        client,
        isWebchatConnect: () => false,
        context: {
          authorization: { mode: "legacy" },
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
        methodRegistry: registry,
      });
      return respond;
    };

    expect(await dispatch(sharedTab.id)).toHaveBeenCalledWith(true, { ok: true });
    expect(await dispatch(privateTab.id)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "resource not found" }),
    );
    revokeTeamsSession({ id: session.id, revokedByPrincipalId: session.principalId });
    expect(await dispatch(sharedTab.id)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "authentication required" }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
