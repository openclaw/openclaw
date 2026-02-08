import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSpoolEvent } from "../writer.js";

// Mock the shared isolated turn runner
vi.mock("../../agents/isolated-turn/index.js", () => ({
  runIsolatedAgentTurn: vi.fn(),
}));

import type { CliDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { runIsolatedAgentTurn } from "../../agents/isolated-turn/index.js";
import { runSpoolIsolatedAgentTurn } from "./run.js";

describe("runSpoolIsolatedAgentTurn", () => {
  const mockCfg = {} as OpenClawConfig;
  const mockDeps = {} as CliDeps;

  beforeEach(() => {
    vi.mocked(runIsolatedAgentTurn).mockReset();
    vi.mocked(runIsolatedAgentTurn).mockResolvedValue({
      status: "ok",
      summary: "done",
    });
  });

  it("converts SpoolEvent to IsolatedAgentTurnParams", async () => {
    const event = buildSpoolEvent({
      version: 1,
      payload: {
        kind: "agentTurn",
        message: "Hello from spool",
        agentId: "test-agent",
        sessionKey: "custom:session",
        model: "anthropic/claude-opus-4",
        thinking: "high",
        delivery: {
          enabled: true,
          channel: "telegram",
          to: "123456",
        },
      },
    });

    await runSpoolIsolatedAgentTurn({
      cfg: mockCfg,
      deps: mockDeps,
      event,
    });

    expect(runIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: mockCfg,
        deps: mockDeps,
        message: "Hello from spool",
        sessionKey: "custom:session",
        agentId: "test-agent",
        model: "anthropic/claude-opus-4",
        thinking: "high",
        deliver: true,
        channel: "telegram",
        to: "123456",
        lane: "spool",
        source: {
          type: "spool",
          id: event.id,
          name: expect.stringContaining("spool-event-"),
        },
      }),
    );
  });

  it("uses default session key when not provided", async () => {
    const event = buildSpoolEvent({
      version: 1,
      payload: {
        kind: "agentTurn",
        message: "Test",
      },
    });

    await runSpoolIsolatedAgentTurn({
      cfg: mockCfg,
      deps: mockDeps,
      event,
    });

    expect(runIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `spool:${event.id}`,
      }),
    );
  });

  it("uses custom lane when provided", async () => {
    const event = buildSpoolEvent({
      version: 1,
      payload: {
        kind: "agentTurn",
        message: "Test",
      },
    });

    await runSpoolIsolatedAgentTurn({
      cfg: mockCfg,
      deps: mockDeps,
      event,
      lane: "custom-lane",
    });

    expect(runIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "custom-lane",
      }),
    );
  });

  it("handles events without delivery settings", async () => {
    const event = buildSpoolEvent({
      version: 1,
      payload: {
        kind: "agentTurn",
        message: "Test without delivery",
      },
    });

    await runSpoolIsolatedAgentTurn({
      cfg: mockCfg,
      deps: mockDeps,
      event,
    });

    expect(runIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: undefined,
        channel: undefined,
        to: undefined,
      }),
    );
  });

  it("returns result from runIsolatedAgentTurn", async () => {
    vi.mocked(runIsolatedAgentTurn).mockResolvedValue({
      status: "error",
      error: "Something went wrong",
    });

    const event = buildSpoolEvent({
      version: 1,
      payload: {
        kind: "agentTurn",
        message: "Test",
      },
    });

    const result = await runSpoolIsolatedAgentTurn({
      cfg: mockCfg,
      deps: mockDeps,
      event,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("Something went wrong");
  });
});
