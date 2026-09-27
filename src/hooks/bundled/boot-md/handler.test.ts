// Boot.md hook tests cover boot file discovery and injected startup context.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";

const runBootOnce = vi.fn();
const listAgentIds = vi.fn();
const resolveAgentWorkspaceDir = vi.fn();
const MAIN_WORKSPACE_DIR = path.join(path.sep, "ws", "main");

function createMockLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

vi.mock("../../../gateway/boot.js", () => ({ runBootOnce }));
vi.mock("../../../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveAgentWorkspaceDir,
}));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => createMockLogger(),
}));

const { default: runBootChecklist } = await import("./handler.js");

function makeEvent(overrides?: Partial<InternalHookEvent>): InternalHookEvent {
  return {
    type: "gateway",
    action: "startup",
    sessionKey: "test",
    context: {},
    timestamp: new Date(),
    messages: [],
    ...overrides,
  };
}

function expectBootCall(
  index: number,
  expected: { cfg: unknown; workspaceDir: string; agentId: string },
) {
  const params = runBootOnce.mock.calls[index]?.[0] as
    | { cfg?: unknown; workspaceDir?: unknown; agentId?: unknown }
    | undefined;
  if (!params) {
    throw new Error(`missing boot call ${index}`);
  }
  expect(params.cfg).toBe(expected.cfg);
  expect(params.workspaceDir).toBe(expected.workspaceDir);
  expect(params.agentId).toBe(expected.agentId);
}

describe("boot-md handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips non-gateway events", async () => {
    await runBootChecklist(makeEvent({ type: "command", action: "new" }));
    expect(runBootOnce).not.toHaveBeenCalled();
  });

  it("skips non-startup actions", async () => {
    await runBootChecklist(makeEvent({ action: "shutdown" }));
    expect(runBootOnce).not.toHaveBeenCalled();
  });

  it("skips when cfg is missing from context", async () => {
    await runBootChecklist(makeEvent({ context: { workspaceDir: "/tmp" } }));
    expect(runBootOnce).not.toHaveBeenCalled();
  });

  it("deduplicates agents sharing the same workspaceDir (#74072)", async () => {
    const cfg = { agents: { list: [{ id: "main" }, { id: "alias" }] } };
    listAgentIds.mockReturnValue(["main", "alias"]);
    resolveAgentWorkspaceDir.mockReturnValue(MAIN_WORKSPACE_DIR);
    runBootOnce.mockResolvedValue({ status: "ran" });

    await runBootChecklist(makeEvent({ context: { cfg } }));

    expect(runBootOnce).toHaveBeenCalledTimes(1);
    expectBootCall(0, { cfg, workspaceDir: MAIN_WORKSPACE_DIR, agentId: "main" });
  });
});
