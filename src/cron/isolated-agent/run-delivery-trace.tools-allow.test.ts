import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronToolsAllowPreflightDiagnostics } from "./run-delivery-trace.js";

const cfg = {
  mcp: {
    servers: {
      notes: { transport: "stdio", command: "notes-mcp" },
    },
  },
} as OpenClawConfig;

const base = {
  cfg,
  jobId: "job-1",
  provider: "openai",
  model: "gpt-5.4-codex",
  workspaceDir: "/workspace",
  agentRuntime: "codex",
  agentPayload: {
    kind: "agentTurn" as const,
    message: "run",
    toolsAllow: ["read"],
    toolsAllowIsDefault: true,
  },
};

describe("configured MCP inherited-cap diagnostics", () => {
  it("persists an actionable warning for legacy Codex default caps", async () => {
    const diagnostics = await createCronToolsAllowPreflightDiagnostics(base);

    expect(diagnostics?.entries[0]).toMatchObject({
      source: "cron-preflight",
      severity: "warn",
    });
    expect(diagnostics?.summary).toContain("openclaw automations edit job-1 --tools <tool,...>");
  });

  it("does not warn after final executable-surface capture", async () => {
    await expect(
      createCronToolsAllowPreflightDiagnostics({
        ...base,
        toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
        agentPayload: {
          ...base.agentPayload,
          toolsAllow: ["notes__read"],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not warn for a configured MCP server excluded from the run agent", async () => {
    const agentScopedCfg = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "notes-mcp",
            codex: { agents: ["research"] },
          },
        },
      },
    } as OpenClawConfig;
    const scoped = {
      ...base,
      cfg: agentScopedCfg,
      jobId: "job-agent-scope",
    };

    await expect(
      createCronToolsAllowPreflightDiagnostics({ ...scoped, agentId: "support" }),
    ).resolves.toBeUndefined();
    await expect(
      createCronToolsAllowPreflightDiagnostics({ ...scoped, agentId: "research" }),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });
});
