import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createOpenClawTools } from "../agents/openclaw-tools.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";

const createTools = vi.hoisted(() =>
  vi.fn((_args: Parameters<typeof createOpenClawTools>[0]): unknown[] => []),
);

// mock-isolation: Observe plugin tool options without constructing plugin or channel tools.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async (...args: Parameters<typeof createTools>) => createTools(...args),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const memoryAudience: MemoryAudience = Object.freeze({ kind: "owner-private", agentId: "main" });

describe("resolveGatewayScopedTools memory audience", () => {
  beforeEach(() => {
    createTools.mockClear();
  });

  it.each([
    { surface: "loopback" as const, expected: memoryAudience },
    { surface: "http" as const, expected: undefined },
  ])("gives $surface plugin tools the audience $expected", async ({ surface, expected }) => {
    await resolveGatewayScopedTools({
      cfg: {},
      sessionKey: "agent:main:telegram:direct:owner",
      senderIsOwner: true,
      surface,
      memoryAudience,
    });

    expect(createTools).toHaveBeenCalledOnce();
    expect(createTools.mock.calls[0]?.[0]?.memoryAudience).toBe(expected);
  });
});
