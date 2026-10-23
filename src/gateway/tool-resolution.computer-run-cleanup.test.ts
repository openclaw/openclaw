import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as gatewayTools from "../agents/tools/gateway.js";
import {
  claimAgentRunApprovalAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "../plugins/computer-use-registration.js";
import type { OpenClawPluginNodeHostCommand } from "../plugins/types.node-host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

it("retains a computer execution across MCP catalog rebuilds and releases it with its run", async () => {
  const cfg = { plugins: { enabled: false }, tools: { allow: ["computer"] } };
  const admissions = ["computer-first", "computer-next"].map((runId) =>
    prepareSystemAgentRunAdmission(cfg, runId, "main", "mcp-computer-test"),
  );
  const contexts = await Promise.all(admissions.map((admission) => admission.admit("embedded")));
  const closed = contexts.map(() => createDeferredCore());
  const opens: string[] = [];
  const closes: string[] = [];
  const commands = new Map<string, OpenClawPluginNodeHostCommand>();
  const capabilities: ReturnType<ComputerUseProvider["capabilities"]> = {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "computer-generation" },
    actions: ["screenshot", "list_windows"],
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: true, agentCursor: false, multiDisplay: false },
  };
  registerComputerUseProvider(
    { registerNodeHostCommand: (command) => commands.set(command.command, command) },
    {
      id: "fixture",
      label: "Fixture",
      capabilities: () => capabilities,
      isAvailable: () => true,
      openExecution: async ({ executionId }) => {
        opens.push(executionId);
        return {
          snapshot: async () =>
            JSON.stringify({
              format: "png",
              width: 1,
              height: 1,
              screenIndex: 0,
              displayFrameId: "fixture-frame",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            }),
          act: async () => JSON.stringify({ ok: true }),
          close: async (reason) => {
            closes.push(reason);
          },
        };
      },
    },
  );
  const transport = vi
    .spyOn(gatewayTools, "callGatewayTool")
    .mockImplementation(async <T>(method: string, _options: unknown, request?: unknown) => {
      let response: unknown;
      if (method === "node.list") {
        response = {
          nodes: [
            {
              nodeId: "computer-node",
              platform: "linux",
              connected: true,
              commands: [...commands.keys()],
              computerUse: capabilities,
            },
          ],
        };
      } else if (method === "computer.status") {
        response = { configured: false, available: false };
      } else if (method === "node.invoke") {
        if (!isRecord(request) || !isRecord(request.params)) {
          throw new Error("Malformed fixture node invocation");
        }
        const command = commands.get(String(request.command));
        if (!command) {
          throw new Error("Unexpected node command");
        }
        const params = request.params;
        if (params.action === "__close_execution") {
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        }
        response = { payload: JSON.parse(await command.handle(JSON.stringify(params))) };
        if (params.action === "__close_execution") {
          const index = contexts.findIndex(
            (context) => context.operationalRunInstance.instanceId === params.executionId,
          );
          closed[index]?.resolve();
        }
      } else {
        throw new Error(`Unexpected Gateway method: ${method}`);
      }
      return response as T;
    });
  const cache = new McpLoopbackToolCache();
  const resolveComputer = async (index: number) => {
    const admittedRunContext = contexts[index]!;
    const resolved = await cache.resolve({
      cfg,
      grantToken: `computer-grant-${index}`,
      context: {
        admittedRunContext,
        sessionKey: "agent:main:computer",
        senderIsOwner: true,
        runId: admittedRunContext.operationalRunInstance.runId,
        toolsAllow: ["computer"],
        modelHasVision: true,
      } as never,
    });
    const computer = resolved.tools.find((tool) => tool.name === "computer");
    if (!computer) {
      throw new Error("MCP computer tool was not available");
    }
    return wrapToolWithGatewayCallerIdentity(computer, {
      agentId: "main",
      sessionKey: "agent:main:computer",
      operationalRunInstance: admittedRunContext.operationalRunInstance,
      approvalAuthority: getAdmittedRunDelegatedAuthority(admittedRunContext),
    });
  };
  try {
    const first = await resolveComputer(0);
    await first.execute("first-observation", { action: "screenshot", target: "node" });
    const approval = claimAgentRunApprovalAuthority(
      getAdmittedRunDelegatedAuthority(contexts[0]!)!,
      [],
    );
    releaseAgentRunDelegatedAuthority(approval);
    await first.execute("after-approval", { action: "screenshot" });
    expect(closes).toEqual([]);
    cache.clear();
    const rebuilt = await resolveComputer(0);
    await rebuilt.execute("rebuilt-observation", { action: "screenshot", target: "node" });
    expect(opens).toEqual([contexts[0]!.operationalRunInstance.instanceId]);
    admissions[0]!.close();
    await closed[0]!.promise;
    const next = await resolveComputer(1);
    await next.execute("next-observation", { action: "screenshot", target: "node" });
    expect(opens).toEqual(contexts.map((context) => context.operationalRunInstance.instanceId));
    admissions[1]!.close();
    await closed[1]!.promise;
    expect(closes).toEqual(["run-ended", "run-ended"]);
  } finally {
    admissions.forEach((admission) => admission.close());
    await commands.get("screen.snapshot")?.onDisconnect?.();
    cache.clear();
    transport.mockRestore();
  }
});
