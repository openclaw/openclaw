import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSnapshot } from "../config/mutate.test-support.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { hashSystemAgentOperation } from "../system-agent/operator-approval.js";
import { withSystemAgentOverviewSources } from "../system-agent/overview.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveToolsMcpAgentId } from "./agent-session-env.js";
import {
  buildSystemAgentToolsMcpServerConfig,
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_APPROVAL_ARMED_ENV as ARMED_ENV,
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_PROPOSAL_ENV as PROPOSAL_ENV,
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_SURFACE_ENV as SURFACE_ENV,
  OPENCLAW_TOOLS_MCP_TOOLS_ENV as TOOLS_ENV,
  resolveOpenClawToolsMcpSystemAgentSurface as resolveSurface,
  resolveOpenClawToolsMcpToolSelection as resolveSelection,
} from "./openclaw-tools-serve-config.js";
import {
  OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
  resolveOpenClawToolsForMcp,
} from "./openclaw-tools-serve.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-mcp-subagent-policy-");

afterEach(() => {
  vi.unstubAllEnvs();
});

async function handlersFor(params: Parameters<typeof resolveOpenClawToolsForMcp>[0]) {
  return createPluginToolsMcpHandlers(await resolveOpenClawToolsForMcp(params));
}

function serverConfig(options: Parameters<typeof buildSystemAgentToolsMcpServerConfig>[0]) {
  return buildSystemAgentToolsMcpServerConfig(options).mcpServers.openclaw as {
    args: string[];
    env?: Record<string, string>;
  };
}

async function propose(armed: string, configPath: string, value: string) {
  vi.stubEnv(ARMED_ENV, armed);
  vi.stubEnv(TOOLS_ENV, "openclaw");
  vi.stubEnv(SURFACE_ENV, "cli");
  vi.stubEnv(
    PROPOSAL_ENV,
    hashSystemAgentOperation({ kind: "config-set", path: configPath, value }),
  );
  const handlers = await handlersFor({});
  return JSON.stringify(
    await handlers.callTool({
      name: "openclaw",
      arguments: { action: "config_set", path: configPath, value, approved: true },
    }),
  );
}

describe("OpenClaw tools MCP server", () => {
  it("does not expose cron to a persisted sub-agent ACP session", async () => {
    const tempDir = sessionDirs.make();
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:acp:resumed-child";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: `${sessionKey}-session`,
      updatedAt: Date.now(),
      spawnedBy: "agent:main:subagent:parent",
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
    } as SessionEntry);
    vi.stubEnv(OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV, sessionKey);
    const handlers = await handlersFor({
      config: { session: { store: storePath } },
    });

    const listed = await handlers.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain("automations");
    for (const name of ["automations", "cron"]) {
      await expect(handlers.callTool({ name, arguments: { action: "status" } })).resolves.toEqual({
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }
  });

  it("gates cron trigger surfaces by the host config", async () => {
    const jobKeys = async (config: unknown) => {
      vi.stubEnv(OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV, "agent:worker:main");
      const [tool] = await resolveOpenClawToolsForMcp({
        config: config as never,
      });
      if (!tool) {
        throw new Error("expected the automations tool to be resolved");
      }
      const parameters = tool.parameters as unknown as {
        properties: { job: { properties: Record<string, unknown> } };
      };
      return Object.keys(parameters.properties.job.properties);
    };

    expect(await jobKeys({ cron: { triggers: { enabled: false } } })).not.toContain("trigger");
    expect(await jobKeys({ cron: {} })).toContain("trigger");
    expect(await jobKeys({ cron: { triggers: { enabled: true } } })).toContain("trigger");
  });

  it("requires the managed bridge to pass a real agent session key", async () => {
    vi.stubEnv(OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV, "");
    await expect(resolveOpenClawToolsForMcp()).rejects.toThrow(
      OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
    );
  });

  it("keeps the generated helper owner through MCP diagnostic actions", async () => {
    const server = serverConfig({ surface: "gateway", agentId: "work" });
    vi.stubEnv(TOOLS_ENV, server.env?.[TOOLS_ENV]);
    vi.stubEnv(SURFACE_ENV, server.env?.[SURFACE_ENV]);
    const handlers = await handlersFor({
      agentId: resolveToolsMcpAgentId(server.args),
    });

    const result = await withSystemAgentOverviewSources(
      createSnapshot({
        hash: "fixture",
        sourceConfig: {
          agents: {
            ownership: "explicit",
            entries: { work: { model: "openai/gpt-5.6-luna" }, other: { model: "example/other" } },
          },
          gateway: { port: 1 },
        },
      }),
      () => handlers.callTool({ name: "openclaw", arguments: { action: "models" } }),
    );

    expect(JSON.stringify(result)).toContain("Default model: openai/gpt-5.6-luna");
    expect(result.isError).not.toBe(true);
  });

  it("returns approved CLI MCP mutations to the host instead of applying them", async () => {
    expect(await propose("1", "gateway.port", "19001")).toContain("directive:approved-operation:");
  });

  it("parses the served tool selection from env and defaults to cron", () => {
    expect(resolveSelection({})).toEqual(["cron"]);
    expect(resolveSelection({ [TOOLS_ENV]: " openclaw , cron " })).toEqual(["openclaw", "cron"]);
    expect(() => resolveSelection({ [TOOLS_ENV]: "exec" })).toThrow(TOOLS_ENV);
  });

  it("parses the openclaw surface from env and defaults to cli", () => {
    expect(resolveSurface({})).toBe("cli");
    expect(resolveSurface({ [SURFACE_ENV]: "gateway" })).toBe("gateway");
    expect(() => resolveSurface({ [SURFACE_ENV]: "remote" })).toThrow(SURFACE_ENV);
  });

  it("serializes operator-approval-only through the native CLI MCP config", () => {
    const server = serverConfig({
      surface: "cli",
      operatorApprovalOnly: true,
      proposalRef: { current: "deadbeef" },
    });
    expect(server.env?.[ARMED_ENV]).toBe("operator-only");

    expect(serverConfig({ surface: "cli" }).env).not.toHaveProperty(ARMED_ENV);

    expect(serverConfig({ surface: "cli", approvalArmed: true }).env?.[ARMED_ENV]).toBe("1");
  });

  it("reconstructs delegated proposal staging from env on the native CLI MCP tool", async () => {
    const text = await propose("operator-only", "agents.defaults.subagents.thinking", "high");
    expect(text).toContain("needs-approval:");
    expect(text).toContain("requesting session's permission policy");
    expect(text).toContain("returns the final outcome");
    expect(text).not.toContain("OpenClaw operator UI");
    expect(text).not.toContain("ask the user to reply yes");
  });
});
