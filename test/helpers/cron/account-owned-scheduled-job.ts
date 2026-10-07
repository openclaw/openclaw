import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { CronJobCreate } from "../../../src/cron/types.js";

/** Creates through the live Gateway's authenticated automation tool, without a chat ingress. */
export async function createAccountOwnedScheduledJob(params: {
  cfg: OpenClawConfig;
  gatewayPort: number;
  agentId: string;
  accountId: string;
  sessionKey: string;
  model: { provider: string; model: string };
  job: CronJobCreate;
}) {
  // Import after the outer fixture isolates its environment and starts its Gateway.
  const [
    { createTestAdmittedRunContext },
    { withGatewayToolCallerIdentity },
    { McpLoopbackToolCache },
    { getGatewayRecoveryRuntime },
    { getGatewayContextResolver },
    {
      claimAgentRunDelegatedAuthority,
      clearAgentRunContext,
      registerAgentRunContext,
      releaseAgentRunDelegatedAuthority,
      validateAgentRunDelegatedAuthority,
    },
  ] = await Promise.all([
    import("../../../src/agents/admitted-run-context.test-support.js"),
    import("../../../src/agents/tools/gateway-caller-context.js"),
    import("../../../src/gateway/mcp-http.runtime.js"),
    import("../../../src/gateway/server-recovery-runtime-context.js"),
    import("../../../src/plugins/runtime/gateway-request-scope.js"),
    import("../../../src/infra/agent-run-registry.js"),
  ]);
  const recovery = expectDefined(getGatewayRecoveryRuntime(), "outer Gateway recovery owner");
  const resolveGatewayContext = expectDefined(
    getGatewayContextResolver(recovery),
    "outer Gateway context binding",
  );
  const context = expectDefined(resolveGatewayContext(), "live outer Gateway context");
  const cron = context.cron;
  const assertContextCurrent = () => {
    expect(resolveGatewayContext()).toBe(context);
    expect(context.resolveGatewayContext?.()).toBe(context);
    expect(context.recoveryRuntime).toBe(recovery);
    expect(context.getRuntimeConfig()).toBe(params.cfg);
    expect(params.cfg.gateway?.port).toBe(params.gatewayPort);
    expect(context.cron).toBe(cron);
  };
  assertContextCurrent();

  const runId = "scheduled-account-creator-" + randomUUID();
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, assertContextCurrent);
  const controller = new AbortController();
  const cache = new McpLoopbackToolCache();
  try {
    registerAgentRunContext(runId, {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    return await withGatewayToolCallerIdentity(
      {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        turnSourceLocal: true,
        turnSourceAccountId: params.accountId,
        operationalRunInstance,
        approvalAuthority: authority,
        approvalSignals: [controller.signal],
        receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
        gatewayContextResolver: resolveGatewayContext,
      },
      async () => {
        const scoped = await cache.resolve({
          cfg: params.cfg,
          signal: controller.signal,
          context: {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            runId,
            accountId: params.accountId,
            modelProvider: params.model.provider,
            modelId: params.model.model,
            senderIsOwner: true,
            toolsAllow: ["automations", "message"],
            nativeCronCreatorToolAllowlist: [],
          },
        });
        assertContextCurrent();
        expect(scoped.toolSchema.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["automations", "message"]),
        );
        const automations = expectDefined(
          scoped.tools.find((tool) => tool.name === "automations"),
          "authenticated creator automation tool",
        );
        const result = await automations.execute(
          "create-account-owned-job",
          { action: "add", job: structuredClone(params.job) },
          controller.signal,
        );
        assertContextCurrent();
        const response = isRecord(result.details) ? result.details : undefined;
        const id = expectDefined(
          typeof response?.id === "string" ? response.id : undefined,
          "created automation id",
        );
        return { id };
      },
    );
  } finally {
    controller.abort();
    cache.clear();
    releaseAgentRunDelegatedAuthority(authority);
    clearAgentRunContext(runId, authority.lifecycleGeneration);
  }
}
