import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

describe("sessions_spawn context preparation", () => {
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
        params: expect.objectContaining({ bootstrapContextMode: "lightweight" }),
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
});
