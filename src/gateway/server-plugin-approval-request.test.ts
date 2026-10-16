import { describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { dispatchTrustedPluginGatewayMethod } from "./server-plugins.js";

describe("trusted plugin approval requests", () => {
  it("respects the caller's write-only named role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const caller = createOperatorClient({
        profileName: "named-role-plugin-caller",
        scopes: ["operator.write"],
      });
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: {
                agents: "*",
                scopes: ["operator.write"],
                sessions: { others: "write" },
              },
            },
          },
        },
      };
      const context = createContext();
      context.getRuntimeConfig = () => cfg;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "plugin.approval.request",
            scope: "operator.approvals",
            owner: { kind: "core", area: "plugin-approval" },
            handler: ({ respond }: GatewayRequestHandlerOptions) => {
              respond(true, { status: "accepted" });
            },
          },
        ]);

      await withPluginRuntimeGatewayRequestScope(
        { client: caller, context, isWebchatConnect: () => false },
        () =>
          withPluginRuntimePluginScope({ pluginId: "lobster", pluginOrigin: "bundled" }, () =>
            expect(
              dispatchTrustedPluginGatewayMethod(
                "plugin.approval.request",
                { pluginId: "lobster", title: "Review workflow", description: "No effect" },
                { scopes: ["operator.approvals"] },
              ),
            ).resolves.toEqual({ status: "accepted" }),
          ),
      );
    });
  });

  it("lets a write-only tool caller request review without allowing it to resolve review", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const caller = createOperatorClient({
        profileName: "plugin-tool-caller",
        scopes: ["operator.write"],
      });
      const context = createContext();
      let requestClient: GatewayRequestOptions["client"] = null;
      let resolveCalled = false;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "plugin.approval.request",
            scope: "operator.approvals",
            owner: { kind: "core", area: "plugin-approval" },
            handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
              requestClient = client;
              respond(true, { status: "accepted" });
            },
          },
          {
            name: "plugin.approval.resolve",
            scope: "operator.approvals",
            owner: { kind: "core", area: "plugin-approval" },
            handler: ({ respond }: GatewayRequestHandlerOptions) => {
              resolveCalled = true;
              respond(true, { ok: true });
            },
          },
        ]);

      await withPluginRuntimeGatewayRequestScope(
        { client: caller, context, isWebchatConnect: () => false },
        () =>
          withPluginRuntimePluginScope(
            { pluginId: "lobster", pluginOrigin: "bundled" },
            async () => {
              await expect(
                dispatchTrustedPluginGatewayMethod(
                  "plugin.approval.request",
                  { pluginId: "lobster", title: "Review workflow", description: "No effect" },
                  { scopes: ["operator.approvals"] },
                ),
              ).resolves.toEqual({ status: "accepted" });
              expect(requestClient?.connect.scopes).toEqual(["operator.write"]);
              expect(requestClient?.internal?.pluginApprovalRequestOwnerId).toBe("lobster");
              expect(requestClient?.internal?.approvalRuntime).not.toBe(true);

              await expect(
                dispatchTrustedPluginGatewayMethod(
                  "plugin.approval.resolve",
                  { id: "plugin:test", decision: "allow-once" },
                  { scopes: ["operator.approvals"] },
                ),
              ).rejects.toThrow(/missing scope: operator\.approvals/);
              expect(resolveCalled).toBe(false);
            },
          ),
      );
    });
  });

  it("accepts a live signed hook owner without granting reviewer scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const caller = createOperatorClient({
        profileName: "signed-hook-caller",
        scopes: ["operator.write"],
      });
      const identity = {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
          operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        },
        approvalOwnerPluginId: "registered-hook",
      } as const;
      const context = createContext();
      context.validateAgentRuntimeApprovalAuthority = (candidate) => candidate === identity;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "plugin.approval.request",
            scope: "operator.approvals",
            owner: { kind: "core", area: "plugin-approval" },
            handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
              expect(client?.connect.scopes).toEqual(["operator.write"]);
              expect(client?.internal?.pluginApprovalRequestOwnerId).toBe("registered-hook");
              expect(client?.internal?.approvalRuntime).not.toBe(true);
              respond(true, { status: "accepted" });
            },
          },
        ]);
      const dispatchOptions = withInProcessAgentRuntimeIdentity(
        {
          forceSyntheticClient: true,
          allowHostPluginApprovalRequest: true,
          syntheticScopes: ["operator.approvals"],
          syntheticScopeMode: "minimum" as const,
          resolveGatewayContext: () => context,
        },
        identity,
      );

      await withPluginRuntimeGatewayRequestScope(
        { client: caller, context, isWebchatConnect: () => false },
        () =>
          expect(
            dispatchGatewayMethodInProcess(
              "plugin.approval.request",
              { title: "Review hook", description: "No effect" },
              dispatchOptions,
            ),
          ).resolves.toEqual({ status: "accepted" }),
      );

      context.validateAgentRuntimeApprovalAuthority = () => false;
      await withPluginRuntimeGatewayRequestScope(
        { client: caller, context, isWebchatConnect: () => false },
        () =>
          expect(
            dispatchGatewayMethodInProcess(
              "plugin.approval.request",
              { title: "Review hook", description: "No effect" },
              dispatchOptions,
            ),
          ).rejects.toThrow(/missing scope: operator\.approvals/),
      );
    });
  });

  it("uses a retained write-only operator for a signed hook after the client scope ends", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = createOperatorClient({
        profileName: "retained-hook-operator",
        scopes: ["operator.write"],
      });
      const authority = createAdmittedRunOperatorAuthority({
        profileId: source.authenticatedUserProfile!.profileId,
        scopes: ["operator.write"],
        assertCurrent: () => undefined,
        readCurrentRoleAssignment: () => "writer",
      });
      const identity = {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
          operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        },
        approvalOwnerPluginId: "registered-hook",
      } as const;
      let roleScopes: Array<"operator.write" | "operator.read"> = ["operator.write"];
      const cfg = (): OpenClawConfig => ({
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: {
                agents: "*",
                scopes: roleScopes,
                sessions: { others: "write" },
              },
            },
          },
        },
      });
      const context = createContext();
      context.getRuntimeConfig = cfg;
      context.getCommittedRuntimeConfig = cfg;
      context.validateAgentRuntimeApprovalAuthority = (candidate) => candidate === identity;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "plugin.approval.request",
            scope: "operator.approvals",
            owner: { kind: "core", area: "plugin-approval" },
            handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
              expect(client?.connect.scopes).toEqual(["operator.write"]);
              expect(client?.internal?.pluginApprovalRequestOwnerId).toBe("registered-hook");
              respond(true, { status: "accepted" });
            },
          },
        ]);
      const dispatchOptions = withInProcessAgentRuntimeIdentity(
        {
          forceSyntheticClient: true,
          allowHostPluginApprovalRequest: true,
          syntheticScopes: ["operator.approvals"],
          syntheticScopeMode: "minimum" as const,
          resolveGatewayContext: () => context,
        },
        identity,
      );
      const request = () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            operatorAuthority: authority,
            gatewayContextResolver: () => context,
          },
          () =>
            dispatchGatewayMethodInProcess(
              "plugin.approval.request",
              { title: "Review hook", description: "No effect" },
              dispatchOptions,
            ),
        );

      await expect(request()).resolves.toEqual({ status: "accepted" });
      const unrelatedReader = createOperatorClient({
        profileName: "unrelated-hook-reader",
        scopes: ["operator.read"],
      });
      await withPluginRuntimeGatewayRequestScope(
        { client: unrelatedReader, context, isWebchatConnect: () => false },
        () => expect(request()).rejects.toThrow(/missing scope: operator\.approvals/),
      );
      roleScopes = ["operator.read"];
      await expect(request()).rejects.toThrow(/Your operator role changed/);
    });
  });

  it("does not offer the bridge to a read-only caller", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const caller = createOperatorClient({
        profileName: "read-only-plugin-caller",
        scopes: ["operator.read"],
      });
      const context = createContext();
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "plugin.approval.request",
            scope: "operator.approvals",
            owner: { kind: "core", area: "plugin-approval" },
            handler: ({ respond }: GatewayRequestHandlerOptions) => {
              respond(true, { status: "accepted" });
            },
          },
        ]);

      await withPluginRuntimeGatewayRequestScope(
        { client: caller, context, isWebchatConnect: () => false },
        () =>
          withPluginRuntimePluginScope({ pluginId: "lobster", pluginOrigin: "bundled" }, () =>
            expect(
              dispatchTrustedPluginGatewayMethod(
                "plugin.approval.request",
                { pluginId: "lobster", title: "Review workflow", description: "No effect" },
                { scopes: ["operator.approvals"] },
              ),
            ).rejects.toThrow(/missing scope: operator\.approvals/),
          ),
      );
    });
  });

  it("does not offer the bridge to an untrusted plugin", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const caller = createOperatorClient({
        profileName: "untrusted-plugin-caller",
        scopes: ["operator.write"],
      });
      const context = createContext();
      await withPluginRuntimeGatewayRequestScope(
        { client: caller, context, isWebchatConnect: () => false },
        () =>
          withPluginRuntimePluginScope(
            { pluginId: "untrusted-probe", pluginOrigin: "config" },
            () =>
              expect(
                dispatchTrustedPluginGatewayMethod(
                  "plugin.approval.request",
                  {
                    pluginId: "untrusted-probe",
                    title: "Review workflow",
                    description: "No effect",
                  },
                  { scopes: ["operator.approvals"] },
                ),
              ).rejects.toThrow(/only available to bundled or trusted official plugins/),
          ),
      );
    });
  });
});
