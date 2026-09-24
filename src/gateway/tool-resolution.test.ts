import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as gatewayTools from "../agents/tools/gateway.js";
import {
  buildTurnSendTargetKey,
  commitTurnSend,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../agents/tools/turn-send-ledger.js";
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

// The message tool keys the send ledger on the agentId-scoped session key it builds
// internally (pollEchoSessionKey in message-tool-execution.ts), not the raw session key.
// #114388 made that key `${agentId}\0${sessionKey}` so concurrent agents sharing one
// session stay isolated. Seed the ledger with the exact string the tool will peek with,
// derived through the same resolver production uses; a hand-built raw key would silently
// miss the slot and let the cap stay inert even when the wiring under test is correct.
function ledgerSessionKey(sessionKey: string): string {
  return `${resolveSessionAgentId({ sessionKey })}\0${sessionKey}`;
}

// Seed one committed send for a (turn, target) via the reserve->commit primitive the
// tools use, so the opt-in cap of 1 is already reached when the tool under test peeks.
function seedCommittedSend(key: { sessionKey: string; runId: string; targetKey: string }): void {
  const reserved = reserveTurnSend(key, {});
  if (reserved.status !== "reserved") {
    throw new Error(`expected to seed a reserved send, got "${reserved.status}"`);
  }
  commitTurnSend(reserved.reservation);
}

describe("resolveGatewayScopedTools", () => {
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
      actions: [
        "screenshot",
        "list_windows",
        "browser_set_input_files",
        "browser_download",
        "get_recording_state",
        "start_recording",
        "stop_recording",
        "replay_trajectory",
      ],
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
        // The fixture implements the generic Gateway wire response boundary.
        return response as T;
      });
    const cache = new McpLoopbackToolCache();
    const expectOrdinaryActions = (parameters: unknown) => {
      for (const action of [
        "browser_set_input_files",
        "browser_download",
        "get_recording_state",
        "start_recording",
        "stop_recording",
        "replay_trajectory",
      ]) {
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
    expect(result.tools.some((tool) => tool.name === "message")).toBe(true);
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
    expect(result.tools.some((tool) => tool.name === "agents_wait")).toBe(false);
    expect(spawn?.parameters).not.toHaveProperty("properties.collect");
    await expect(
      spawn!.execute("uncollectable", { task: "inspect", collect: true }),
    ).rejects.toThrow("Collector results are unavailable");
  });

  it("keeps default-agent credentials out of unbound gateway calls", async () => {
    const cfg = { agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } } };
    const unbound = await resolveTools({ cfg });
    const grantBound = await resolveTools({ cfg, agentDir: "/agents/cli" });
    expect(unbound.tools.some((tool) => tool.name === "view_image")).toBe(false);
    expect(grantBound.tools.some((tool) => tool.name === "view_image")).toBe(true);
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
      expect(result.tools.some((tool) => tool.name === "computer")).toBe(modelHasVision !== false);
    }
  });

  it("limits gateway actions to the borrowed runtime policy without reassigning the session", async () => {
    const result = await resolveTools({
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
      runtimePolicyAgentId: "worker",
      senderIsOwner: true,
    });
    expect(result.agentId).toBe("main");
    expect(result.tools.find((tool) => tool.name === "gateway")?.parameters).toHaveProperty(
      "properties.action.enum",
      ["update.run"],
    );
  });

  it("rejects a runtime policy agent that conflicts with its session key", async () => {
    await expect(
      resolveTools({
        cfg: { agents: { ownership: "explicit", entries: { main: {}, worker: {} } } },
        agentId: "main",
        runtimePolicySessionKey: "agent:worker:main",
        runtimePolicyAgentId: "main",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it.each([
    {
      label: "policy group",
      resolve: resolveMcpLoopbackPolicyTools,
      toolsAllow: ["group:fs"],
      expected: ["ls", "read"],
    },
    {
      label: "exact ls",
      resolve: resolveMcpLoopbackScopedTools,
      toolsAllow: ["ls"],
      expected: ["ls"],
    },
    {
      label: "exact group",
      resolve: resolveMcpLoopbackScopedTools,
      toolsAllow: ["group:fs"],
      expected: [],
    },
  ])("materializes $label without widening its cap", async ({ resolve, toolsAllow, expected }) => {
    const scope = {
      cfg: {
        plugins: { enabled: false },
        tools: { profile: "minimal" as const, alsoAllow: ["ls", "read"] },
      },
      context: {
        sessionKey: "agent:main:cron:listing-surface",
        workspaceDir: path.join(os.tmpdir(), "openclaw-listing-surface"),
        senderIsOwner: true,
        toolsAllow,
      },
    };
    const allowed = await resolve(scope);
    expect(allowed.tools.map((tool) => tool.name)).toEqual(expected);
    const denied = await resolve({
      ...scope,
      cfg: { ...scope.cfg, tools: { ...scope.cfg.tools, deny: ["ls"] } },
    });
    expect(denied.tools.map((tool) => tool.name)).toEqual(expected.filter((name) => name !== "ls"));
  });

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
    const toolsAllow = projected.tools.map((tool) => tool.name);
    const granted = await resolveMcpLoopbackScopedTools({
      cfg,
      context: { ...context, toolsAllow },
    });
    for (const result of [projected, granted]) {
      expect(result.tools.some((tool) => tool.name === "exec")).toBe(false);
      expect(result.tools.some((tool) => tool.name === "process")).toBe(false);
      expect(result.tools.some((tool) => tool.name === "read")).toBe(false);
    }
  });

  it("applies sandbox tool denies to sandboxed loopback turns", async () => {
    const result = await resolveTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
      },
    });
    const names = result.tools.map((tool) => tool.name);
    expect(names).not.toContain("sessions_list");
    expect(names).toContain("sessions_history");
  });
});

describe("resolveGatewayScopedTools per-turn send ledger wiring", () => {
  afterEach(() => {
    resetTurnSendLedgerForTest();
  });

  // The per-turn send budget only activates when runId reaches the message tool
  // (message-tool.ts builds its budget context only for a defined runId). The Gateway
  // loopback path must forward runId, or the ledger is silently inert for every
  // ordinary Gateway turn. Pre-seed one send for this turn/target, then prove the
  // opt-in cap of 1 blocks the tool the resolver produced — impossible unless runId
  // is wired through.
  it("forwards runId so the message tool per-turn cap engages on the loopback surface", async () => {
    const sessionKey = "agent:main:telegram:group:-100123";
    const runId = "gw-run-1";
    const targetKey = buildTurnSendTargetKey({ channel: "telegram", target: "peer-1" });
    seedCommittedSend({ sessionKey: ledgerSessionKey(sessionKey), runId, targetKey });

    const result = await resolveGatewayScopedTools({
      cfg: {
        tools: { profile: "minimal", message: { maxMessagesPerTurnPerTarget: 1 } },
      } as OpenClawConfig,
      sessionKey,
      runId,
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
    const messageTool = result.tools.find((tool) => tool.name === "message");
    if (!messageTool) {
      throw new Error("expected message tool");
    }

    const blocked = await messageTool.execute("gw-msg-1", {
      action: "send",
      channel: "telegram",
      to: "peer-1",
      message: "second variant",
    });
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
  });

  // The current-source send must key the ledger on the routable messaging target
  // (what conversations_send uses), not the native channel id. Seed the budget for
  // the routable target only, then send with no explicit target while native and
  // routable differ. This blocks only if currentMessagingTarget threads through
  // resolveGatewayScopedTools -> createOpenClawTools -> the message tool; without it
  // the no-target send falls back to the native id and misses the seeded slot.
  it("threads the routable currentMessagingTarget so a current-source send shares the ledger slot", async () => {
    const sessionKey = "agent:main:slack:dm:U123";
    const runId = "gw-run-2";
    const targetKey = buildTurnSendTargetKey({ channel: "slack", target: "user:U123" });
    seedCommittedSend({ sessionKey: ledgerSessionKey(sessionKey), runId, targetKey });

    const result = await resolveGatewayScopedTools({
      cfg: {
        tools: { profile: "minimal", message: { maxMessagesPerTurnPerTarget: 1 } },
      } as OpenClawConfig,
      sessionKey,
      runId,
      messageProvider: "slack",
      // Native channel id and routable target intentionally differ, and agentTo is
      // left unset exactly as the production loopback resolve leaves it. That keeps
      // the seeded slot reachable only via currentMessagingTarget: were the routable
      // target dropped, the resolver's `?? agentTo` fallback would be undefined and
      // the no-target send would key on the native "D123" instead, missing the slot.
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
    const messageTool = result.tools.find((tool) => tool.name === "message");
    if (!messageTool) {
      throw new Error("expected message tool");
    }

    const blocked = await messageTool.execute("gw-msg-2", {
      action: "send",
      channel: "slack",
      message: "second variant to current source",
    });
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
  });
});
