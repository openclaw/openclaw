import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { revokeMcpLoopbackClientGrant } from "../mcp-grant-store.js";
import { request, runtime, toolCall } from "../mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import {
  cfg,
  stateDir,
  cron,
  inRun,
  createCronFixture,
  createCreatorTransportTools,
  type CreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";

// mock-isolation: Attached-node inventory is independent of the real MCP and Cron boundary.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

installRequesterCronAuthorityTestHooks();

it("retains an admitted owner's automation management through CLI construction, not later callers", async () => {
  const config: OpenClawConfig = {
    ...cfg,
    agents: { ...cfg.agents, defaults: { workspace: stateDir } },
    commands: { ownerAllowFrom: ["discord:owner-1"] },
    tools: { allow: [AUTOMATIONS_TOOL_NAME] },
  };
  setRuntimeConfigSnapshot(config);
  const fixture = createCronFixture(undefined, config);
  const job = await cron.add({
    name: "Legacy reminder",
    enabled: false,
    schedule: { kind: "every", everyMs: 1_800_000 },
    sessionTarget: "isolated",
    agentId: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Check status" },
    delivery: { mode: "none" },
  });
  expect((await fixture.read())[0]?.owner).toBeUndefined();
  const listed = async (tools: CreatorTransportTools) => {
    const result = (await tools.invoke(AUTOMATIONS_TOOL_NAME, {
      action: "list",
      includeDisabled: true,
    })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as { scope: string; jobs: Array<{ id: string }> };
  };
  const update = (tools: CreatorTransportTools, name: string) =>
    tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "update", jobId: job.id, job: { name } });
  const isCurrent = () =>
    isConfiguredCommandOwner(getRuntimeConfig(), { channel: "discord", senderId: "owner-1" });
  // The process-owned listener has no admitted turn or Cron construction scope.
  await ensureMcpLoopbackServer();
  try {
    const runId = "fresh-channel-owner";
    await inRun(
      runId,
      {
        runId,
        callerOrigin: { kind: "unknown" },
        managementEntitlement: { source: "channel-owner", isCurrent },
        isCurrent,
      },
      async (_identity, admitted, creator) => {
        bindGatewayContextResolver(admitted, () => fixture.context);
        let capture: CreatorTransportTools["mcpCapture"];
        try {
          const tools = await createCreatorTransportTools({
            transport: "cli",
            config,
            admitted,
            creator,
            senderIsOwner: true,
          });
          capture = tools.mcpCapture;
          const list = await listed(tools);
          expect(list.scope).toBe("gateway");
          expect(list.jobs.map((entry) => entry.id)).toContain(job.id);
          await expect(
            tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "get", jobId: job.id }),
          ).resolves.toMatchObject({ content: [{ text: expect.stringContaining(job.id) }] });
          await update(tools, "Reviewed legacy reminder");
          expect((await fixture.read())[0]).toMatchObject({ name: "Reviewed legacy reminder" });
          expect((await fixture.read())[0]).not.toHaveProperty("owner");

          setRuntimeConfigSnapshot({ ...config, commands: { ownerAllowFrom: [] } });
          await expect(update(tools, "Must not persist after owner removal")).rejects.toThrow(
            /Automation (caller authority is no longer active|admin grant)/i,
          );
          setRuntimeConfigSnapshot(config);
          const grant = expectDefined(capture, "owner CLI grant");
          expect(revokeMcpLoopbackClientGrant(grant.token)).toBe(true);
          const rejected = await request(
            runtime(),
            toolCall(AUTOMATIONS_TOOL_NAME, { action: "get", jobId: job.id }),
            grant,
          );
          expect(rejected.status).toBe(401);
        } finally {
          if (capture) {
            revokeMcpLoopbackClientGrant(capture.token);
          }
          clearGatewayContextResolver(admitted);
        }
      },
    );
    await inRun("unentitled-later-run", undefined, async (_identity, admitted) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      let capture: CreatorTransportTools["mcpCapture"];
      try {
        const tools = await createCreatorTransportTools({
          transport: "cli",
          config,
          admitted,
          senderIsOwner: true,
        });
        capture = tools.mcpCapture;
        expect(await listed(tools)).toMatchObject({ scope: "caller", jobs: [] });
        await expect(update(tools, "Must not inherit management")).rejects.toThrow(
          /not found.*cross-session management/i,
        );
      } finally {
        if (capture) {
          revokeMcpLoopbackClientGrant(capture.token);
        }
        clearGatewayContextResolver(admitted);
      }
    });
    expect((await fixture.read())[0]).toMatchObject({ name: "Reviewed legacy reminder" });
    expect((await fixture.read())[0]).not.toHaveProperty("owner");
  } finally {
    await closeMcpLoopbackServer();
  }
});
