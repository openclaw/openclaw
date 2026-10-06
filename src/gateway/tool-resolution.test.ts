import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
