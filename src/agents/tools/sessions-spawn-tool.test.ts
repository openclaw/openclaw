import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  return {
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
  };
});

vi.mock("../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../acp-spawn.js", () => ({
  ACP_SPAWN_MODES: ["run", "session"],
  ACP_SPAWN_STREAM_TARGETS: ["parent"],
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;

async function loadFreshSessionsSpawnToolModuleForTest(opts?: { awaitEnabled?: boolean }) {
  vi.resetModules();
  vi.doMock("../subagent-spawn.js", () => ({
    SUBAGENT_SPAWN_MODES: ["run", "session"],
    spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
  }));
  vi.doMock("../acp-spawn.js", () => ({
    ACP_SPAWN_MODES: ["run", "session"],
    ACP_SPAWN_STREAM_TARGETS: ["parent"],
    spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
  }));
  vi.doMock("../../config/config.js", () => ({
    loadConfig: () => ({
      agents: { defaults: { subagents: { awaitEnabled: opts?.awaitEnabled ?? false } } },
    }),
  }));
  ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
}

describe("sessions_spawn tool", () => {
  beforeEach(async () => {
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    await loadFreshSessionsSpawnToolModuleForTest();
  });

  it("uses subagent runtime by default", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-1", {
      task: "build feature",
      agentId: "main",
      model: "anthropic/claude-sonnet-4-6",
      thinking: "medium",
      runTimeoutSeconds: 5,
      thread: true,
      mode: "session",
      cleanup: "keep",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "build feature",
        agentId: "main",
        model: "anthropic/claude-sonnet-4-6",
        thinking: "medium",
        runTimeoutSeconds: 5,
        thread: true,
        mode: "session",
        cleanup: "keep",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("does not default to waitForCompletion when omitted", async () => {
    await loadFreshSessionsSpawnToolModuleForTest({ awaitEnabled: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "openresponses-user:alice",
    });

    await tool.execute("call-openresponses-wait", {
      task: "research and report",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        waitForCompletion: true,
      }),
      expect.any(Object),
    );
  });

  it("passes waitForCompletion=true only when explicitly requested", async () => {
    await loadFreshSessionsSpawnToolModuleForTest({ awaitEnabled: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:openresponses-user:alice",
    });

    await tool.execute("call-openresponses-canonical-wait", {
      task: "research and report",
      waitForCompletion: true,
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "research and report",
        waitForCompletion: true,
      }),
      expect.any(Object),
    );
  });

  it("rejects waitForCompletion=true when awaitEnabled is false", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "openresponses-user:alice",
    });

    const result = await tool.execute("call-openresponses-no-wait", {
      task: "research and report",
      waitForCompletion: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("awaitEnabled=true");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("omits await-only schema fields when awaitEnabled is false", () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "openresponses-user:alice",
    });
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties).not.toHaveProperty("waitForCompletion");
    expect(schema.properties).not.toHaveProperty("suppressAnnounce");
  });

  it("includes await-only schema fields when awaitEnabled is true", () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "openresponses-user:alice",
      awaitEnabled: true,
    });
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties).toHaveProperty("waitForCompletion");
    expect(schema.properties).toHaveProperty("suppressAnnounce");
  });

  it("passes suppressAnnounce through to spawnSubagentDirect", async () => {
    await loadFreshSessionsSpawnToolModuleForTest({ awaitEnabled: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-suppress-announce", {
      task: "parallel analysis",
      suppressAnnounce: true,
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "parallel analysis",
        suppressAnnounce: true,
      }),
      expect.any(Object),
    );
  });

  it("honors injected awaitEnabled option when config fallback is false", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      awaitEnabled: true,
    });

    await tool.execute("call-injected-await-enabled", {
      task: "parallel analysis",
      waitForCompletion: true,
      suppressAnnounce: true,
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "parallel analysis",
        waitForCompletion: true,
        suppressAnnounce: true,
      }),
      expect.any(Object),
    );
  });

  it("rejects await-only flags when injected awaitEnabled=false overrides config", async () => {
    await loadFreshSessionsSpawnToolModuleForTest({ awaitEnabled: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      awaitEnabled: false,
    });

    const result = await tool.execute("call-injected-await-disabled", {
      task: "parallel analysis",
      waitForCompletion: true,
      suppressAnnounce: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("awaitEnabled=true");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("passes inherited workspaceDir from tool context, not from tool args", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "/parent/workspace",
    });

    await tool.execute("call-ws", {
      task: "inspect AGENTS",
      workspaceDir: "/tmp/attempted-override",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        workspaceDir: "/parent/workspace",
      }),
    );
  });

  it("rejects waitForCompletion for ACP runtime", async () => {
    await loadFreshSessionsSpawnToolModuleForTest({ awaitEnabled: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-acp-wait-invalid", {
      runtime: "acp",
      task: "investigate in ACP and wait",
      waitForCompletion: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("waitForCompletion/suppressAnnounce are only supported");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("rejects suppressAnnounce for ACP runtime", async () => {
    await loadFreshSessionsSpawnToolModuleForTest({ awaitEnabled: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-acp-suppress-invalid", {
      runtime: "acp",
      task: "investigate in ACP with suppress",
      suppressAnnounce: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("waitForCompletion/suppressAnnounce are only supported");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("routes to ACP runtime when runtime=acp", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-2", {
      runtime: "acp",
      task: "investigate the failing CI run",
      agentId: "codex",
      cwd: "/workspace",
      thread: true,
      mode: "session",
      streamTo: "parent",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "investigate the failing CI run",
        agentId: "codex",
        cwd: "/workspace",
        thread: true,
        mode: "session",
        streamTo: "parent",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("forwards ACP sandbox options and requester sandbox context", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
      sandboxed: true,
    });

    await tool.execute("call-2b", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
      sandbox: "require",
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "investigate",
        sandbox: "require",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:subagent:parent",
        sandboxed: true,
      }),
    );
  });

  it("passes resumeSessionId through to ACP spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-2c", {
      runtime: "acp",
      task: "resume prior work",
      agentId: "codex",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "resume prior work",
        agentId: "codex",
        resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
      }),
      expect.any(Object),
    );
  });

  it("rejects resumeSessionId without runtime=acp", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-guard", {
      task: "resume prior work",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
    });

    expect(JSON.stringify(result)).toContain("resumeSessionId is only supported for runtime=acp");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects attachments for ACP runtime", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-3", {
      runtime: "acp",
      task: "analyze file",
      attachments: [{ name: "a.txt", content: "hello", encoding: "utf8" }],
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("attachments are currently unsupported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it('rejects streamTo when runtime is not "acp"', async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-3b", {
      runtime: "subagent",
      task: "analyze file",
      streamTo: "parent",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("streamTo is only supported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("keeps attachment content schema unconstrained for llama.cpp grammar safety", () => {
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        attachments?: {
          items?: {
            properties?: {
              content?: {
                type?: string;
                maxLength?: number;
              };
            };
          };
        };
      };
    };

    const contentSchema = schema.properties?.attachments?.items?.properties?.content;
    expect(contentSchema?.type).toBe("string");
    expect(contentSchema?.maxLength).toBeUndefined();
  });
});
