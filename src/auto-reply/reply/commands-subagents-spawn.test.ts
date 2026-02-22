import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSubagentRegistryForTests } from "../../agents/subagent-registry.js";
import type { SpawnSubagentResult } from "../../agents/subagent-spawn.js";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const callGatewayMock = vi.fn();
  return { spawnSubagentDirectMock, callGatewayMock };
});

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
  SUBAGENT_SPAWN_MODES: ["run", "session"],
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

// Prevent transitive import chain from reaching discord/monitor which needs https-proxy-agent.
vi.mock("../../discord/monitor/gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: () => ({}),
}));

// Dynamic import to ensure mocks are installed first.
const { handleSubagentsCommand } = await import("./commands-subagents.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

const { spawnSubagentDirectMock } = hoisted;

function acceptedResult(overrides?: Partial<SpawnSubagentResult>): SpawnSubagentResult {
  return {
    status: "accepted",
    childSessionKey: "agent:beta:subagent:test-uuid",
    runId: "run-spawn-1",
    ...overrides,
  };
}

function forbiddenResult(error: string): SpawnSubagentResult {
  return {
    status: "forbidden",
    error,
  };
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/subagents spawn command", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    spawnSubagentDirectMock.mockClear();
    hoisted.callGatewayMock.mockClear();
  });

  it("shows usage when agentId is missing", async () => {
    const params = buildCommandTestParams("/subagents spawn", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Usage:");
    expect(result?.reply?.text).toContain("/subagents spawn");
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("shows usage when task is missing", async () => {
    const params = buildCommandTestParams("/subagents spawn beta", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Usage:");
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("spawns subagent and confirms reply text and child session key", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");
    expect(result?.reply?.text).toContain("agent:beta:subagent:test-uuid");
    expect(result?.reply?.text).toContain("run-spaw");

    expect(spawnSubagentDirectMock).toHaveBeenCalledOnce();
    const [spawnParams, spawnCtx] = spawnSubagentDirectMock.mock.calls[0];
    expect(spawnParams.task).toBe("do the thing");
    expect(spawnParams.agentId).toBe("beta");
    expect(spawnParams.mode).toBe("run");
    expect(spawnParams.cleanup).toBe("keep");
    expect(spawnParams.expectsCompletionMessage).toBe(true);
    expect(spawnCtx.agentSessionKey).toBeDefined();
  });

  it("spawns with --model flag and passes model to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult({ modelApplied: true }));
    const params = buildCommandTestParams(
      "/subagents spawn beta do the thing --model openai/gpt-4o",
      baseCfg,
    );
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");

    const [spawnParams] = spawnSubagentDirectMock.mock.calls[0];
    expect(spawnParams.model).toBe("openai/gpt-4o");
    expect(spawnParams.task).toBe("do the thing");
  });

  it("spawns with --thinking flag and passes thinking to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const params = buildCommandTestParams(
      "/subagents spawn beta do the thing --thinking high",
      baseCfg,
    );
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");

    const [spawnParams] = spawnSubagentDirectMock.mock.calls[0];
    expect(spawnParams.thinking).toBe("high");
    expect(spawnParams.task).toBe("do the thing");
  });

  it("passes group context from session entry to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg);
    params.sessionEntry = {
      sessionId: "session-main",
      updatedAt: Date.now(),
      groupId: "group-1",
      groupChannel: "#group-channel",
      space: "workspace-1",
    };
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");

    const [, spawnCtx] = spawnSubagentDirectMock.mock.calls[0];
    expect(spawnCtx).toMatchObject({
      agentGroupId: "group-1",
      agentGroupChannel: "#group-channel",
      agentGroupSpace: "workspace-1",
    });
  });

  it("prefers CommandTargetSessionKey for native /subagents spawn", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg, {
      CommandSource: "native",
      CommandTargetSessionKey: "agent:main:main",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:12345",
    });
    params.sessionKey = "agent:main:slack:slash:u1";

    const result = await handleSubagentsCommand(params, true);

    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");
    const [, spawnCtx] = spawnSubagentDirectMock.mock.calls[0];
    expect(spawnCtx.agentSessionKey).toBe("agent:main:main");
    expect(spawnCtx.agentChannel).toBe("discord");
    expect(spawnCtx.agentTo).toBe("channel:12345");
  });

  it("falls back to OriginatingTo for agentTo when command.to is missing", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg, {
      OriginatingTo: "channel:manual",
      To: "channel:fallback-from-to",
    });
    params.command.to = undefined;

    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");

    const [, spawnCtx] = spawnSubagentDirectMock.mock.calls[0];
    expect(spawnCtx).toMatchObject({ agentTo: "channel:manual" });
  });
  it("returns forbidden for unauthorized cross-agent spawn", async () => {
    spawnSubagentDirectMock.mockResolvedValue(
      forbiddenResult("agentId is not allowed for sessions_spawn (allowed: alpha)"),
    );
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawn failed");
    expect(result?.reply?.text).toContain("not allowed");
  });

  it("allows cross-agent spawn when in allowlist", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Spawned subagent beta");
  });

  it("ignores unauthorized sender (silent, no reply)", async () => {
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg, {
      CommandAuthorized: false,
    });
    params.command.isAuthorizedSender = false;
    const result = await handleSubagentsCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply).toBeUndefined();
    expect(result?.shouldContinue).toBe(false);
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("returns null when text commands disabled", async () => {
    const params = buildCommandTestParams("/subagents spawn beta do the thing", baseCfg);
    const result = await handleSubagentsCommand(params, false);
    expect(result).toBeNull();
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });
});
