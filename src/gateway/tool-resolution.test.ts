import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

describe("resolveGatewayScopedTools", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    ["telegram", "agent:main:telegram:group:-100123", undefined, true],
    ["webchat", "agent:main:webchat:forge-main", undefined, false],
    ["webchat", "agent:main:telegram:group:-100123", "message_tool_only", true],
  ] as const)(
    "selects %s room delivery for %s with mode=%s: message=%s",
    async (messageProvider, sessionKey, sourceReplyDeliveryMode, message) => {
      const result = await resolveTools({
        cfg: { tools: { profile: "minimal" } },
        sessionKey,
        messageProvider,
        sourceReplyDeliveryMode,
        inboundEventKind: "room_event",
      });
      expect(result.tools.some((tool) => tool.name === "message")).toBe(message);
    },
  );

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

  it.each([false, true])(
    "exposes managed shell without bypassing tool denies (denied=%s)",
    async (denied) => {
      const cfg = {
        plugins: { enabled: false },
        tools: { profile: "coding", ...(denied ? { deny: ["exec", "process"] } : {}) },
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
        expect(result.tools.some((tool) => tool.name === "exec")).toBe(!denied);
        expect(result.tools.some((tool) => tool.name === "process")).toBe(!denied);
        expect(result.tools.some((tool) => tool.name === "read")).toBe(false);
      }
    },
  );

  it("materializes an executable write tool on the mediated CLI surface", async () => {
    const workspaceDir = tempDirs.make("openclaw-mediated-write-");
    const result = await resolveTools({
      sessionKey: "agent:main:cron:mediated-write",
      workspaceDir,
      mediatedToolNames: ["write"],
      excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
    });
    const writeTool = result.tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();
    await writeTool?.execute("mediated-write-call", {
      path: "proof.txt",
      content: "mediated write ok",
    });
    await expect(fs.readFile(path.join(workspaceDir, "proof.txt"), "utf8")).resolves.toBe(
      "mediated write ok",
    );
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

  it("passes loopback yield context into sessions_yield", async () => {
    const registry = await import("../agents/subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockResolvedValue(1);
    const onYield = vi.fn();
    try {
      const result = await resolveTools({
        cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } },
        sessionKey: "agent:main:telegram:group:-100123",
        sessionId: "session-123",
        runId: "run-123",
        onYield,
      });
      const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
      if (!yieldTool) {
        throw new Error("expected sessions_yield tool");
      }
      const toolResult = await yieldTool.execute("tool-call-1", {
        message: "waiting on subagents",
        acknowledgment: "I’m waiting on the subagents.",
      });
      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:telegram:group:-100123",
        requesterTurnRunId: "run-123",
      });
      expect(onYield).toHaveBeenCalledWith(
        "waiting on subagents",
        "I’m waiting on the subagents.",
        undefined,
      );
      expect(toolResult.details).toEqual({
        status: "yielded",
        acknowledgment: "I’m waiting on the subagents.",
      });
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});
