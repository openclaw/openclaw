import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

describe("sessions_spawn context preparation and session diagnostics", () => {
  const callGatewayMock = vi.fn();
  const forkSessionFromParentMock = vi.fn();
  const ensureContextEnginesInitializedMock = vi.fn();
  const resolveContextEngineMock = vi.fn();
  let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      forkSessionFromParentMock,
      ensureContextEnginesInitializedMock,
      resolveContextEngineMock,
    }));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  it("keeps lightContext isolated spawns out of context-engine preparation", async () => {
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect(
      { task: "clean worker", context: "isolated", lightContext: true },
      { agentSessionKey: "main" },
    );

    expect(result.status).toBe("accepted");
    expect(forkSessionFromParentMock).not.toHaveBeenCalled();
    expect(ensureContextEnginesInitializedMock).not.toHaveBeenCalled();
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
    expect(prepareSubagentSpawn).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "default",
        }),
      }),
    );
  });

  it("caps oversized context engine subagent TTLs at the timer-safe ceiling", async () => {
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect(
      {
        task: "clean worker",
        runTimeoutSeconds: Number.MAX_SAFE_INTEGER,
      },
      { agentSessionKey: "main" },
    );

    expect(result.status).toBe("accepted");
    expect(prepareSubagentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: MAX_TIMER_TIMEOUT_MS }),
    );
  });

  it("names usable alternatives before a thread retry", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("thread: true");
      expect(result.error).toContain('mode="run"');
      expect(result.error).not.toContain("sessions_send");
    }
  });

  it("rejects thread=true with actionable guidance when no hook is registered", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
        thread: true,
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("not running on a channel");
      expect(result.error).toContain('mode="run"');
      expect(result.error).not.toContain("sessions_send");
    }
  });
});
