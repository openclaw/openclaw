import { describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { dispatchTrustedPluginGatewayMethod } from "./server-plugins.js";

const requestParams = { title: "Review workflow", description: "No effect" };
const accepted = { status: "accepted" };
const missingScope = /missing scope: operator\.approvals/;
const hookIdentity = {
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

function writerConfig(
  scopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.write"],
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "writer",
        definitions: {
          writer: { agents: "*", scopes, sessions: { others: "write" } },
        },
      },
    },
  };
}

function fixture(scopes = ["operator.write"]) {
  const caller = createOperatorClient({ profileName: "plugin-caller", scopes });
  const request = vi.fn(({ respond }: GatewayRequestHandlerOptions) => respond(true, accepted));
  const resolve = vi.fn(({ respond }: GatewayRequestHandlerOptions) => respond(true, { ok: true }));
  const context = createContext([
    ["plugin.approval.request", "operator.approvals", "plugin-approval", request],
    ["plugin.approval.resolve", "operator.approvals", "plugin-approval", resolve],
  ]);
  const scoped = <T>(run: () => Promise<T>, client = caller) =>
    withPluginRuntimeGatewayRequestScope({ client, context, isWebchatConnect: () => false }, run);
  const trusted = (pluginId = "lobster", pluginOrigin: "bundled" | "config" = "bundled") =>
    scoped(() =>
      withPluginRuntimePluginScope({ pluginId, pluginOrigin }, () =>
        dispatchTrustedPluginGatewayMethod(
          "plugin.approval.request",
          { pluginId, ...requestParams },
          { scopes: ["operator.approvals"] },
        ),
      ),
    );
  const hookOptions = withInProcessAgentRuntimeIdentity(
    {
      forceSyntheticClient: true,
      allowHostPluginApprovalRequest: true,
      syntheticScopes: ["operator.approvals"],
      syntheticScopeMode: "minimum" as const,
      resolveGatewayContext: () => context,
    },
    hookIdentity,
  );
  const hook = () =>
    dispatchGatewayMethodInProcess("plugin.approval.request", requestParams, hookOptions);
  return { caller, context, request, resolve, scoped, trusted, hook };
}

describe("trusted plugin approval requests", () => {
  it("respects the caller's write-only named role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const cfg = writerConfig();
      f.context.getRuntimeConfig = () => cfg;
      await expect(f.trusted()).resolves.toEqual(accepted);
    });
  });

  it("lets a write-only tool caller request review without allowing it to resolve review", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      await expect(f.trusted()).resolves.toEqual(accepted);
      const client = f.request.mock.calls[0]?.[0].client;
      expect(client?.connect.scopes).toEqual(["operator.write"]);
      expect(client?.internal?.pluginApprovalRequestOwnerId).toBe("lobster");
      expect(client?.internal?.approvalRuntime).not.toBe(true);
      await expect(
        f.scoped(() =>
          withPluginRuntimePluginScope({ pluginId: "lobster", pluginOrigin: "bundled" }, () =>
            dispatchTrustedPluginGatewayMethod(
              "plugin.approval.resolve",
              { id: "plugin:test", decision: "allow-once" },
              { scopes: ["operator.approvals"] },
            ),
          ),
        ),
      ).rejects.toThrow(missingScope);
      expect(f.resolve).not.toHaveBeenCalled();
    });
  });

  it("accepts a live signed hook owner without granting reviewer scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      f.context.validateAgentRuntimeApprovalAuthority = (candidate) => candidate === hookIdentity;
      await expect(f.scoped(f.hook)).resolves.toEqual(accepted);
      const client = f.request.mock.calls[0]?.[0].client;
      expect(client?.connect.scopes).toEqual(["operator.write"]);
      expect(client?.internal?.pluginApprovalRequestOwnerId).toBe("registered-hook");
      expect(client?.internal?.approvalRuntime).not.toBe(true);
      f.context.validateAgentRuntimeApprovalAuthority = () => false;
      await expect(f.scoped(f.hook)).rejects.toThrow(missingScope);
    });
  });

  it("uses a retained write-only operator for a signed hook after the client scope ends", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: f.caller.authenticatedUserProfile!.profileId,
        scopes: ["operator.write"],
        assertCurrent: () => undefined,
        readCurrentRoleFacts: () => ({ assignedRole: "writer" }),
      });
      let roleScopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.write"];
      const cfg = () => writerConfig(roleScopes);
      f.context.getRuntimeConfig = cfg;
      f.context.getCommittedRuntimeConfig = cfg;
      f.context.validateAgentRuntimeApprovalAuthority = (candidate) => candidate === hookIdentity;
      const request = () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            operatorAuthority: authority,
            gatewayContextResolver: () => f.context,
          },
          f.hook,
        );
      await expect(request()).resolves.toEqual(accepted);
      const client = f.request.mock.calls[0]?.[0].client;
      expect(client?.connect.scopes).toEqual(["operator.write"]);
      expect(client?.internal?.pluginApprovalRequestOwnerId).toBe("registered-hook");
      const unrelatedReader = createOperatorClient({
        profileName: "unrelated-hook-reader",
        scopes: ["operator.read"],
      });
      await expect(f.scoped(request, unrelatedReader)).rejects.toThrow(missingScope);
      roleScopes = ["operator.read"];
      await expect(request()).rejects.toThrow(/Your operator role changed/);
    });
  });

  it("does not offer the bridge to a read-only caller", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await expect(fixture(["operator.read"]).trusted()).rejects.toThrow(missingScope);
    });
  });

  it("does not offer the bridge to an untrusted plugin", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await expect(fixture().trusted("untrusted-probe", "config")).rejects.toThrow(
        /only available to bundled or trusted official plugins/,
      );
    });
  });
});
