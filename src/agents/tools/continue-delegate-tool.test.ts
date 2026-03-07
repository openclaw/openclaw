import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingDelegates,
  consumeStagedPostCompactionDelegates,
} from "../../auto-reply/continuation-delegate-store.js";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

import { createContinueDelegateTool } from "./continue-delegate-tool.js";

describe("continue_delegate tool", () => {
  let liveConfigOverride: Record<string, unknown>;

  beforeEach(() => {
    consumePendingDelegates("test-session");
    consumeStagedPostCompactionDelegates("test-session");
    liveConfigOverride = {};
    loadConfigMock.mockReset();
    loadConfigMock.mockImplementation(() => liveConfigOverride);
  });

  async function executeTool(
    tool: ReturnType<typeof createContinueDelegateTool>,
    index: number,
    args: Record<string, unknown>,
  ) {
    return (await tool.execute(`call-${index}`, args))?.details as Record<string, unknown>;
  }

  it("reads maxDelegatesPerTurn at execute time instead of tool construction time", async () => {
    liveConfigOverride = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 5 } } },
    };
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    liveConfigOverride = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 10 } } },
    };

    for (let index = 0; index < 10; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const overflow = await executeTool(tool, 10, { task: "delegate 11" });
    expect(overflow).toMatchObject({
      status: "error",
      limit: 10,
    });
  });

  it("re-reads maxDelegatesPerTurn on each call", async () => {
    liveConfigOverride = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 10 } } },
    };
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    for (let index = 0; index < 5; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    liveConfigOverride = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 5 } } },
    };

    const overflow = await executeTool(tool, 5, { task: "delegate 6" });
    expect(overflow).toMatchObject({
      status: "error",
      limit: 5,
    });
  });

  it("uses the runtime default of 5 when maxDelegatesPerTurn is unset", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    for (let index = 0; index < 5; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const overflow = await executeTool(tool, 5, { task: "delegate 6" });
    expect(overflow).toMatchObject({
      status: "error",
      limit: 5,
    });
  });
});
