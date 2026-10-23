import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as gatewayTools from "../agents/tools/gateway.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { computerCapabilities } from "./desktop/computer.test-support.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

async function resolveTools(
  overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {},
) {
  return await resolveGatewayScopedTools({
    cfg: {},
    sessionKey: "agent:main:main",
    surface: "loopback",
    ...overrides,
  });
}
const toolNames = (result: { tools: { name: string }[] }) => result.tools.map(({ name }) => name);

beforeEach(() => setRuntimeConfigSnapshot({}));

it.each([
  ["webchat", false, true],
  ["whatsapp", false, false],
  ["webchat", true, false],
] as const)(
  "gates ask_user in %s (deny: %s, available: %s)",
  async (messageProvider, deny, available) => {
    const result = await resolveTools({
      cfg: {
        plugins: { enabled: false },
        tools: { allow: ["ask_user"], deny: deny ? ["ask_user"] : [] },
      },
      messageProvider,
      senderIsOwner: true,
    });
    expect(toolNames(result).includes("ask_user")).toBe(available);
  },
);

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
  const restrictedActions = [
    "browser_set_input_files",
    "browser_download",
    "get_recording_state",
    "start_recording",
    "stop_recording",
    "replay_trajectory",
  ] as const;
  const capabilities: ReturnType<ComputerUseProvider["capabilities"]> = {
    ...computerCapabilities(
      { id: "fixture", label: "Fixture", generation: "computer-generation" },
      ["screenshot", "list_windows", ...restrictedActions],
    ),
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
        assert(isRecord(request) && isRecord(request.params), "Malformed fixture node invocation");
        const command = commands.get(String(request.command));
        assert(command, "Unexpected node command");
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
      // The fixture implements the generic Gateway wire response boundary.
      return response as T;
    });
  const cache = new McpLoopbackToolCache();
  const expectOrdinaryActions = (parameters: unknown) => {
    for (const action of restrictedActions) {
      expect(parameters).not.toMatchObject({
        properties: { action: { enum: expect.arrayContaining([action]) } },
      });
    }
  };
  const resolveComputer = async (index: number) => {
    const admittedRunContext = contexts[index]!;
    const resolved = await cache.resolve({
      cfg,
      admittedRunContext,
      grantToken: `computer-grant-${index}`,
      context: {
        sessionKey: "agent:main:computer",
        senderIsOwner: true,
        runId: admittedRunContext.operationalRunInstance.runId,
        toolsAllow: ["computer"],
        modelHasVision: true,
      },
    });
    const computer = resolved.tools.find((tool) => tool.name === "computer");
    assert(computer, "MCP computer tool was not available");
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
    expectOrdinaryActions(first.parameters);
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
    expectOrdinaryActions(rebuilt.parameters);
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

it("adds the message tool for Telegram room delivery", async () => {
  const result = await resolveTools({
    cfg: { tools: { profile: "minimal" } },
    sessionKey: "agent:main:telegram:group:-100123",
    messageProvider: "telegram",
    inboundEventKind: "room_event",
  });
  expect(toolNames(result)).toContain("message");
});

it("rejects collector mode after gateway policy removes its reader", async () => {
  const result = await resolveTools({
    cfg: {
      agents: { entries: { main: {} } },
      tools: { profile: "coding" },
      gateway: { tools: { deny: ["agents_wait"] } },
    },
  });
  const spawn = result.tools.find((tool) => tool.name === "sessions_spawn");
  expect(spawn).toBeDefined();
  expect(toolNames(result)).not.toContain("agents_wait");
  expect(spawn?.parameters).not.toHaveProperty("properties.collect");
  await expect(spawn!.execute("uncollectable", { task: "inspect", collect: true })).rejects.toThrow(
    "Collector results are unavailable",
  );
});

it("keeps default-agent credentials out of unbound gateway calls", async () => {
  const cfg = { agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } } };
  const unbound = await resolveTools({ cfg });
  const grantBound = await resolveTools({ cfg, agentDir: "/agents/cli" });
  expect(toolNames(unbound)).not.toContain("view_image");
  expect(toolNames(grantBound)).toContain("view_image");
});

it("keeps unknown and disabled model vision distinct in cached tools", async () => {
  const cache = new McpLoopbackToolCache();
  const cfg = { tools: { allow: ["computer"] } };
  for (const modelHasVision of [undefined, false]) {
    const result = await cache.resolve({
      cfg,
      context: {
        sessionKey: "agent:main:vision-context",
        senderIsOwner: true,
        modelHasVision,
      },
    });
    expect(toolNames(result).includes("computer")).toBe(modelHasVision !== false);
  }
});

it.each(["worker", "main"])(
  "binds runtime policy to %s without reassigning the session",
  async (agent) => {
    const resolving = resolveTools({
      cfg: {
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: {
            main: { tools: { profile: "full" } },
            worker: { tools: { profile: "coding" } },
          },
        },
      },
      agentId: "main",
      runtimePolicySessionKey: "agent:worker:main",
      runtimePolicyAgentId: agent,
      senderIsOwner: true,
    });
    if (agent === "main") {
      await expect(resolving).rejects.toThrowError(
        expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
      );
      return;
    }
    const result = await resolving;
    expect(result.agentId).toBe("main");
    expect(result.tools.find((tool) => tool.name === "gateway")?.parameters).toHaveProperty(
      "properties.action.enum",
      ["update.run"],
    );
  },
);

it.each([
  ["policy group", resolveMcpLoopbackPolicyTools, ["group:fs"], ["ls", "read"]],
  ["exact ls", resolveMcpLoopbackScopedTools, ["ls"], ["ls"]],
  ["exact group", resolveMcpLoopbackScopedTools, ["group:fs"], []],
] as const)(
  "materializes %s without widening its cap",
  async (_label, resolve, toolsAllow, expected) => {
    const scope = {
      cfg: {
        plugins: { enabled: false },
        tools: { profile: "minimal" as const, alsoAllow: ["ls", "read"] },
      },
      context: {
        sessionKey: "agent:main:cron:listing-surface",
        workspaceDir: path.join(os.tmpdir(), "openclaw-listing-surface"),
        senderIsOwner: true,
        toolsAllow: [...toolsAllow],
      },
    };
    const allowed = await resolve(scope);
    expect(toolNames(allowed)).toEqual(expected);
    const denied = await resolve({
      ...scope,
      cfg: { ...scope.cfg, tools: { ...scope.cfg.tools, deny: ["ls"] } },
    });
    expect(toolNames(denied)).toEqual(expected.filter((name) => name !== "ls"));
  },
);

it("keeps managed shell tools subject to explicit denies", async () => {
  const cfg = {
    plugins: { enabled: false },
    tools: { profile: "coding", deny: ["exec", "process"] },
  } satisfies OpenClawConfig;
  const context = { sessionKey: "agent:main:managed-shell", workspaceDir: os.tmpdir() };
  const projected = await resolveMcpLoopbackScopedTools({
    cfg,
    context,
    defaultMediatedToolNames: ["exec", "process"],
  });
  const toolsAllow = toolNames(projected);
  const granted = await resolveMcpLoopbackScopedTools({
    cfg,
    context: { ...context, toolsAllow },
  });
  for (const result of [projected, granted]) {
    expect(toolNames(result).filter((name) => ["exec", "process", "read"].includes(name))).toEqual(
      [],
    );
  }
});

it("applies sandbox tool denies to sandboxed loopback turns", async () => {
  const result = await resolveTools({
    cfg: {
      agents: { defaults: { sandbox: { mode: "all" } } },
      tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
    },
  });
  const names = toolNames(result);
  expect(names).not.toContain("sessions_list");
  expect(names).toContain("sessions_history");
});
