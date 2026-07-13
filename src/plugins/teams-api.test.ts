import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  createAuthorizationAgentSessionBinding,
  GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
  revokeAuthorizationAgentSessionBinding,
} from "../gateway/authorization/agent-session-bindings.js";
import { bindGatewayClientAuthorizationDomain } from "../gateway/authorization/client-domain.js";
import { createAuthorizationDelegation } from "../gateway/authorization/delegations.test-support.js";
import { withGatewayAuthorizationContext } from "../gateway/authorization/request-context.js";
import { createStateGatewayAuthorizationRuntime } from "../gateway/authorization/state-provider.js";
import {
  addIsolationDomainMember,
  bindAuthorizationResource,
  createIsolationDomain,
  grantAuthorizationPermission,
  putAuthorizationPrincipal,
  revokeAuthorizationPermission,
} from "../gateway/authorization/state-store.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
} from "../gateway/methods/registry.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import type { GatewayClient } from "../gateway/server-methods/shared-types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginTeamsApi } from "./teams-api.js";
import {
  bindPluginToolAuthorizationSubject,
  withPluginToolAuthorizationInvocation,
} from "./tool-authorization-context.js";

const tempDirs: string[] = [];
const owner = {
  id: "principal-owner",
  principal: { issuer: "trusted-proxy", subject: "owner@example.com", kind: "human" },
} as const;
const agent = {
  id: "principal-agent",
  principal: { issuer: "core", subject: "agent:main", kind: "service" },
} as const;
const member = {
  id: "principal-member",
  principal: { issuer: "trusted-proxy", subject: "member@example.com", kind: "human" },
} as const;
const workspace = { namespace: "workspaces", type: "workspace", id: "workspace-1" } as const;
const tab = { namespace: "workspaces", type: "tab", id: "tab-1" } as const;
const agentSession = { namespace: "core", type: "agent-session", id: "assignment-1" } as const;

const agentSessionProof = {
  id: "binding-1",
  invokingPrincipal: owner.principal,
} as const;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function createDatabase() {
  return { path: `${makeTempDir(tempDirs, "openclaw-teams-api-")}/openclaw.sqlite` };
}

function seed(database: ReturnType<typeof createDatabase>) {
  putAuthorizationPrincipal({ ...owner, database });
  createIsolationDomain({ id: "domain-1", ownerPrincipalId: owner.id, database });
  bindAuthorizationResource({
    domainId: "domain-1",
    resource: workspace,
    ownerPrincipalId: owner.id,
    database,
  });
}

function authorizationContext() {
  return Object.freeze({
    principalId: owner.id,
    principalKind: "human" as const,
    domain: Object.freeze({ id: "domain-1" }),
    method: "workspaces.tab.create",
    permission: "workspaces.workspace.createTab",
    resources: Object.freeze([workspace]),
    pluginId: "workspaces",
    requestId: "request-1",
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetPluginLoaderTestStateForTest();
});
afterAll(() => {
  cleanupTempDirs(tempDirs);
  cleanupPluginLoaderFixturesForTest();
});

describe("host-bound plugin Teams API", () => {
  it("does not invoke a plugin tool callback when its signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();

    expect(() =>
      withPluginToolAuthorizationInvocation(
        {
          pluginId: "workspaces",
          toolName: "workspace_get",
          toolCallId: "aborted-call",
          context: {},
          signal: controller.signal,
        },
        run,
      ),
    ).toThrow(/aborted/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed without a trusted authorization request", () => {
    const teams = createPluginTeamsApi({ pluginId: "workspaces" });
    expect(() => teams.context.require()).toThrow(/trusted.*authorization context/i);
  });

  it("derives tenant and actor identity and rejects a copied context token", async () => {
    const database = createDatabase();
    seed(database);
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });
    const trusted = authorizationContext();

    await withGatewayAuthorizationContext(trusted, async () => {
      const context = teams.context.require();
      expect(context).toEqual({
        isolationDomainId: "domain-1",
        principal: { id: owner.id, kind: "human" },
        requestId: "request-1",
      });

      await expect(
        teams.resources.prepareRegister({
          context: { ...context },
          resource: tab,
          parent: workspace,
          requiredAction: "workspaces.workspace.createTab",
          idempotencyKey: "create-tab-1",
        }),
      ).rejects.toThrow(/trusted teams request context/i);
    });
  });

  it("rechecks additional resource permissions for the active gateway request", async () => {
    const database = createDatabase();
    seed(database);
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource: tab,
      parent: workspace,
      ownerPrincipalId: owner.id,
      database,
    });
    for (const permission of ["workspaces.tab.read", "workspaces.tab.write"]) {
      grantAuthorizationPermission({
        domainId: "domain-1",
        principalId: member.id,
        resource: tab,
        permission,
        grantedByPrincipalId: owner.id,
        database,
      });
    }
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });
    const trusted = Object.freeze({
      principalId: member.id,
      principalKind: "human" as const,
      principal: member.principal,
      domain: Object.freeze({ id: "domain-1" }),
      method: "workspaces.tab.get",
      permission: "workspaces.tab.read",
      resources: Object.freeze([tab]),
      pluginId: "workspaces",
      requestId: "request-capabilities-1",
    });

    await withGatewayAuthorizationContext(trusted, async () => {
      const context = teams.context.require();
      await expect(
        teams.authorization.decide({
          context,
          permission: "workspaces.tab.write",
          resources: [tab],
        }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        teams.authorization.decide({
          context,
          permission: "workspaces.tab.changeRequest.create",
          resources: [tab],
        }),
      ).resolves.toEqual({ allowed: false });
    });
  });

  it("revokes inherited async-local authority when the request handler returns", async () => {
    const teams = createPluginTeamsApi({ pluginId: "workspaces" });
    const trusted = authorizationContext();
    let resolveProbe: ((error?: Error) => void) | undefined;
    const probed = new Promise<Error | undefined>((resolve) => {
      resolveProbe = resolve;
    });

    withGatewayAuthorizationContext(trusted, () => {
      setImmediate(() => {
        try {
          expect(() => teams.context.require()).toThrow(/active trusted gateway authorization/i);
          resolveProbe?.();
        } catch (error) {
          resolveProbe?.(asError(error));
        }
      });
    });

    const error = await probed;
    if (error) {
      throw error;
    }
  });

  it("cannot suppress request lifetime cleanup by overriding Promise.finally", async () => {
    const teams = createPluginTeamsApi({ pluginId: "workspaces" });
    const trusted = authorizationContext();
    let resolveProbe: ((error?: Error) => void) | undefined;
    const probed = new Promise<Error | undefined>((resolve) => {
      resolveProbe = resolve;
    });
    const handlerResult = Promise.resolve();
    void Object.defineProperty(handlerResult, "finally", {
      value: () => handlerResult,
    });

    await withGatewayAuthorizationContext(trusted, () => {
      void handlerResult.then(() => {
        setImmediate(() => {
          try {
            expect(() => teams.context.require()).toThrow(/active trusted gateway authorization/i);
            resolveProbe?.();
          } catch (error) {
            resolveProbe?.(asError(error));
          }
        });
      });
      return handlerResult;
    });

    const error = await probed;
    if (error) {
      throw error;
    }
  });

  it("rechecks request lifetime after lazy host operations suspend", async () => {
    const database = createDatabase();
    seed(database);
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });
    let register: Promise<string> | undefined;
    let retire: Promise<string> | undefined;
    let lookup: Promise<{ principalId: string }> | undefined;

    withGatewayAuthorizationContext(authorizationContext(), () => {
      const context = teams.context.require();
      register = teams.resources.prepareRegister({
        context,
        resource: tab,
        parent: workspace,
        requiredAction: "workspaces.workspace.createTab",
        idempotencyKey: "escaped-register",
      });
    });
    withGatewayAuthorizationContext(
      Object.freeze({
        ...authorizationContext(),
        permission: "workspaces.workspace.retire",
      }),
      () => {
        const context = teams.context.require();
        retire = teams.resources.prepareRetire({
          context,
          resource: workspace,
          requiredAction: "workspaces.workspace.retire",
          idempotencyKey: "escaped-retire",
        });
      },
    );
    withGatewayAuthorizationContext(
      Object.freeze({
        ...authorizationContext(),
        permission: "workspaces.workspace.read",
      }),
      () => {
        const context = teams.context.require();
        lookup = teams.resources.owner({ context, resource: workspace });
      },
    );

    await expect(register).rejects.toThrow(/active trusted teams request context/i);
    await expect(retire).rejects.toThrow(/active trusted teams request context/i);
    await expect(lookup).rejects.toThrow(/active trusted teams request context/i);
  });

  it("rejects resources outside the loader-bound plugin namespace", async () => {
    const database = createDatabase();
    seed(database);
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });

    await withGatewayAuthorizationContext(authorizationContext(), async () => {
      const context = teams.context.require();
      await expect(
        teams.resources.prepareRegister({
          context,
          resource: { namespace: "core", type: "session", id: "session-1" },
          parent: workspace,
          requiredAction: "workspaces.workspace.createTab",
          idempotencyKey: "cross-namespace-1",
        }),
      ).rejects.toThrow(/loader-bound plugin namespace/i);
    });
  });

  it("binds resource operations to the host plugin identity and persisted domain", async () => {
    const database = createDatabase();
    seed(database);
    const workspaces = createPluginTeamsApi({ pluginId: "workspaces", database });
    const otherPlugin = createPluginTeamsApi({ pluginId: "other-plugin", database });
    const trusted = authorizationContext();
    let operation = "";

    const readContext = Object.freeze({
      ...trusted,
      method: "workspaces.tab.get",
      permission: "workspaces.tab.read",
      resources: Object.freeze([tab]),
      requestId: "request-2",
    });
    await withGatewayAuthorizationContext(trusted, async () => {
      const context = workspaces.context.require();
      expect(() => otherPlugin.context.require()).toThrow(/different plugin/i);
      operation = await workspaces.resources.prepareRegister({
        context,
        resource: tab,
        parent: workspace,
        requiredAction: "workspaces.workspace.createTab",
        idempotencyKey: "create-tab-1",
      });
    });

    await expect(otherPlugin.resources.replayPrepared({ operation })).rejects.toThrow(/unknown/i);
    await expect(workspaces.resources.replayPrepared({ operation })).resolves.toBeUndefined();
    await withGatewayAuthorizationContext(readContext, async () => {
      const context = workspaces.context.require();
      await expect(workspaces.resources.owner({ context, resource: tab })).resolves.toEqual({
        principalId: owner.id,
      });
    });
  });

  it("rejects a Teams context whose authorized resources belong to another plugin", () => {
    const teams = createPluginTeamsApi({ pluginId: "workspaces" });
    const foreignContext = Object.freeze({
      ...authorizationContext(),
      resources: Object.freeze([
        { namespace: "other-plugin", type: "workspace", id: "workspace-1" },
      ]),
    });

    expect(() =>
      withGatewayAuthorizationContext(foreignContext, () => teams.context.require()),
    ).toThrow(/loader-bound plugin namespace/i);
  });

  it("requires a server-attested delegation and keeps the human sponsor as custodian", async () => {
    const database = createDatabase();
    seed(database);
    putAuthorizationPrincipal({ ...agent, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: owner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: owner.id,
      createdByPrincipalId: owner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource: agentSession,
      ownerPrincipalId: owner.id,
      database,
    });
    createAuthorizationAgentSessionBinding({
      id: "binding-1",
      domainId: "domain-1",
      runtimeAgentId: "main",
      sessionKey: "agent:main:main",
      delegationId: "delegation-1",
      assignmentId: "assignment-1",
      createdByPrincipalId: owner.id,
      database,
    });
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });
    const baseAgentContext = Object.freeze({
      ...authorizationContext(),
      principalId: agent.id,
      principalKind: "service" as const,
      requestId: "agent-request-1",
    });

    expect(() =>
      withGatewayAuthorizationContext(baseAgentContext, () => teams.context.require()),
    ).toThrow(/server-attested delegation/i);

    const delegatedContext = Object.freeze({
      ...baseAgentContext,
      delegation: Object.freeze({
        id: "delegation-1",
        assignmentId: "assignment-1",
        sponsorPrincipalId: owner.id,
      }),
    });
    let operation = "";
    await withGatewayAuthorizationContext(delegatedContext, async () => {
      const context = teams.context.require();
      expect(context.principal).toEqual({ id: agent.id, kind: "agent" });
      expect(context.delegatedSession).toEqual({
        id: "delegation-1",
        assignmentId: "assignment-1",
        sponsorPrincipalId: owner.id,
      });
      operation = await teams.resources.prepareRegister({
        context,
        resource: tab,
        parent: workspace,
        requiredAction: "workspaces.workspace.createTab",
        idempotencyKey: "agent-create-tab-1",
      });
    });
    await teams.resources.replayPrepared({ operation });

    const readContext = Object.freeze({
      ...delegatedContext,
      method: "workspaces.tab.get",
      permission: "workspaces.tab.read",
      resources: Object.freeze([tab]),
      requestId: "agent-request-2",
    });
    await withGatewayAuthorizationContext(readContext, async () => {
      const context = teams.context.require();
      await expect(teams.resources.owner({ context, resource: tab })).resolves.toEqual({
        principalId: owner.id,
      });
    });
  });

  it("authorizes the exact active delegated tool call and returns a fresh resource proof", async () => {
    const database = createDatabase();
    seed(database);
    putAuthorizationPrincipal({ ...agent, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: owner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: owner.id,
      createdByPrincipalId: owner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource: agentSession,
      ownerPrincipalId: owner.id,
      database,
    });
    createAuthorizationAgentSessionBinding({
      id: "binding-1",
      domainId: "domain-1",
      runtimeAgentId: "main",
      sessionKey: "agent:main:main",
      delegationId: "delegation-1",
      assignmentId: "assignment-1",
      createdByPrincipalId: owner.id,
      database,
    });
    putAuthorizationPrincipal({ ...member, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: member.id,
      addedByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId: "domain-1",
      principalId: member.id,
      resource: agentSession,
      permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
      grantedByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId: "domain-1",
      principalId: agent.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });
    const toolContext = { agentId: "main", sessionKey: "agent:main:main" };
    bindPluginToolAuthorizationSubject(toolContext, {
      principal: agent.principal,
      domain: { id: "domain-1" },
      delegation: { id: "delegation-1", assignmentId: "assignment-1" },
      agentSession: { id: "binding-1", invokingPrincipal: member.principal },
    });
    let retainedCall: ReturnType<typeof teams.context.require> | undefined;

    await withPluginToolAuthorizationInvocation(
      {
        pluginId: "workspaces",
        toolName: "workspace_get",
        toolCallId: "tool-call-1",
        context: toolContext,
      },
      async () => {
        const call = teams.context.require(toolContext);
        retainedCall = call;
        expect(call).toEqual({ callId: "tool-call-1" });
        expect(() => teams.context.require({ ...toolContext })).toThrow(
          /active host-authorized plugin tool invocation/i,
        );
        const decision = await teams.authorization.decide({
          context: call,
          permission: "workspaces.workspace.read",
          resources: [workspace],
        });
        expect(decision).toEqual({
          allowed: true,
          context: {
            isolationDomainId: "domain-1",
            principal: { id: agent.id, kind: "agent" },
            delegatedSession: {
              id: "delegation-1",
              assignmentId: "assignment-1",
              sponsorPrincipalId: owner.id,
            },
            requestId: "tool-call-1",
          },
        });
        if (!decision.allowed) {
          throw new Error("expected tool authorization to allow");
        }
        await expect(
          teams.resources.owner({ context: decision.context, resource: workspace }),
        ).resolves.toEqual({ principalId: owner.id });

        revokeAuthorizationPermission({
          domainId: "domain-1",
          principalId: member.id,
          resource: agentSession,
          permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
          revokedByPrincipalId: owner.id,
          database,
        });
        await expect(
          teams.authorization.decide({
            context: call,
            permission: "workspaces.workspace.read",
            resources: [workspace],
          }),
        ).resolves.toEqual({ allowed: false });

        grantAuthorizationPermission({
          domainId: "domain-1",
          principalId: member.id,
          resource: agentSession,
          permission: GATEWAY_AGENT_SESSION_INVOKE_PERMISSION,
          grantedByPrincipalId: owner.id,
          database,
        });
        await expect(
          teams.authorization.decide({
            context: call,
            permission: "workspaces.workspace.read",
            resources: [workspace],
          }),
        ).resolves.toMatchObject({ allowed: true });
        revokeAuthorizationAgentSessionBinding({
          domainId: "domain-1",
          id: "binding-1",
          revokedByPrincipalId: owner.id,
          database,
        });
        await expect(
          teams.authorization.decide({
            context: call,
            permission: "workspaces.workspace.read",
            resources: [workspace],
          }),
        ).resolves.toEqual({ allowed: false });
      },
    );

    await expect(
      teams.authorization.decide({
        context: retainedCall as never,
        permission: "workspaces.workspace.read",
        resources: [workspace],
      }),
    ).rejects.toThrow(/no longer active/i);
  });

  it("fails closed for a delegated tool subject with the wrong assignment", async () => {
    const database = createDatabase();
    seed(database);
    putAuthorizationPrincipal({ ...agent, database });
    addIsolationDomainMember({
      domainId: "domain-1",
      principalId: agent.id,
      addedByPrincipalId: owner.id,
      database,
    });
    createAuthorizationDelegation({
      id: "delegation-1",
      assignmentId: "assignment-1",
      domainId: "domain-1",
      agentPrincipalId: agent.id,
      sponsorPrincipalId: owner.id,
      createdByPrincipalId: owner.id,
      database,
    });
    bindAuthorizationResource({
      domainId: "domain-1",
      resource: agentSession,
      ownerPrincipalId: owner.id,
      database,
    });
    createAuthorizationAgentSessionBinding({
      id: "binding-1",
      domainId: "domain-1",
      runtimeAgentId: "main",
      sessionKey: "agent:main:main",
      delegationId: "delegation-1",
      assignmentId: "assignment-1",
      createdByPrincipalId: owner.id,
      database,
    });
    grantAuthorizationPermission({
      domainId: "domain-1",
      principalId: agent.id,
      resource: workspace,
      permission: "workspaces.workspace.read",
      grantedByPrincipalId: owner.id,
      database,
    });
    const teams = createPluginTeamsApi({ pluginId: "workspaces", database });
    const toolContext = { agentId: "main", sessionKey: "agent:main:main" };
    bindPluginToolAuthorizationSubject(toolContext, {
      principal: agent.principal,
      domain: { id: "domain-1" },
      delegation: { id: "delegation-1", assignmentId: "wrong-assignment" },
      agentSession: agentSessionProof,
    });

    await withPluginToolAuthorizationInvocation(
      {
        pluginId: "workspaces",
        toolName: "workspace_get",
        toolCallId: "tool-call-wrong",
        context: toolContext,
      },
      async () => {
        const call = teams.context.require(toolContext);
        await expect(
          teams.authorization.decide({
            context: call,
            permission: "workspaces.workspace.read",
            resources: [workspace],
          }),
        ).resolves.toEqual({ allowed: false });
      },
    );
  });

  it("reaches api.teams through real plugin registration and isolated dispatch", async () => {
    const database = createDatabase();
    seed(database);
    bindAuthorizationResource({
      domainId: "domain-1",
      resource: { namespace: "other-plugin", type: "workspace", id: "foreign-workspace" },
      ownerPrincipalId: owner.id,
      database,
    });
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "workspaces",
      filename: "workspaces.cjs",
      body: `module.exports = {
  id: "workspaces",
  register(api) {
    const workspaceAccess = {
      kind: "resource",
      permission: "workspaces.workspace.read",
      resolveResources: ({ params }) => [
        { namespace: "workspaces", type: "workspace", id: params.workspaceId },
      ],
    };
    api.registerGatewayMethod(
      "workspaces.test.workspace.get",
      () => api.teams.context.require(),
      {
        scope: "operator.read",
        access: workspaceAccess,
      },
    );
    workspaceAccess.permission = "other-plugin.workspace.read";
    workspaceAccess.resolveResources = () => [
      { namespace: "other-plugin", type: "workspace", id: "foreign-workspace" },
    ];
    api.registerGatewayMethod(
      "workspaces.test.foreign.get",
      () => api.teams.context.require(),
      {
        scope: "operator.read",
        access: {
          kind: "resource",
          permission: "other-plugin.workspace.read",
          resolveResources: () => [
            { namespace: "other-plugin", type: "workspace", id: "foreign-workspace" },
          ],
        },
      },
    );
  },
};`,
    });
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: [plugin.id],
        },
      },
    });
    const methodRegistry = createGatewayMethodRegistry(
      createPluginGatewayMethodDescriptors(registry),
    );
    expect(methodRegistry.getAccessPolicy("workspaces.test.workspace.get")).toMatchObject({
      kind: "resource",
      permission: "workspaces.workspace.read",
    });
    const client: GatewayClient = {
      connect: {
        role: "operator" as const,
        scopes: ["operator.read"],
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
      principal: owner.principal,
    };
    bindGatewayClientAuthorizationDomain(client, { id: "domain-1" });
    const respond = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "request-real-plugin",
        method: "workspaces.test.workspace.get",
        params: { workspaceId: workspace.id },
      },
      client,
      respond,
      isWebchatConnect: () => false,
      context: {
        authorization: createStateGatewayAuthorizationRuntime({ database }),
        getRuntimeConfig: () => ({}),
        logGateway: { warn() {} },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        isolationDomainId: "domain-1",
        principal: { id: owner.id, kind: "human" },
        requestId: "request-real-plugin",
      },
      undefined,
      undefined,
    );

    respond.mockClear();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "request-foreign-plugin-resource",
        method: "workspaces.test.foreign.get",
      },
      client,
      respond,
      isWebchatConnect: () => false,
      context: {
        authorization: createStateGatewayAuthorizationRuntime({ database }),
        getRuntimeConfig: () => ({}),
        logGateway: { warn() {} },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "resource not found" }),
    );
  });
});
