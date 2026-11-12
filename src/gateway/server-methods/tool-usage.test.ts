import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toolUsageHandlers } from "./tool-usage.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  import: vi.fn(),
  reset: vi.fn(),
  inventory: vi.fn(),
}));
// mock-isolation: The handler owns request validation/routing, not SQLite or tool factory lifetimes.
vi.mock("../../config/sessions/tool-usage.js", () => ({
  readAgentToolUsageStatus: mocks.read,
  importAgentToolUsage: mocks.import,
  resetAgentToolUsage: mocks.reset,
}));
// mock-isolation: Catalog contents are fixture input; building real tool factories needs plugin runtime state.
vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: mocks.inventory,
}));
const now = Date.UTC(2026, 10, 10);
const config: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.read.mockResolvedValue({ rows: [], lastImportAt: null });
  mocks.import.mockResolvedValue({ rows: [], successfulCalls: 2, scannedEvents: 5, dryRun: true });
  mocks.reset.mockResolvedValue({ generation: 2 });
  mocks.inventory.mockResolvedValue({
    groups: [
      {
        tools: [
          { id: "read", source: "core" },
          { id: "remember", source: "plugin", pluginId: "memory" },
          { id: "remote", source: "mcp", pluginId: "bundle-mcp" },
        ],
      },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function invoke(method: string, params: Record<string, unknown> = {}, current = () => true) {
  const respond = vi.fn();
  await toolUsageHandlers[method]!({
    params,
    respond,
    context: { getRuntimeConfig: () => config } as never,
    client: null,
    req: { type: "req", id: "usage", method },
    isWebchatConnect: () => false,
    hasCurrentClientAuthority: current,
  });
  return respond;
}

it("reports current decayed top scores independently of stored row order", async () => {
  mocks.read.mockResolvedValue({
    rows: [
      { toolId: "openclaw:core:read", score: 4, updatedAt: now - 14 * 86_400_000 },
      { toolId: "openclaw:memory:remember", score: 3, updatedAt: now },
    ],
    lastImportAt: now - 100,
  });
  const respond = await invoke("toolUsage.status", { limit: 1 });
  expect(mocks.read).toHaveBeenCalledWith({ agentId: "main", config, now });
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      enabled: false,
      rowCount: 2,
      lastImportAt: now - 100,
      top: [{ toolId: "openclaw:memory:remember", score: 3, updatedAt: now }],
    }),
  );
});

it("preserves excluded MCP identities for ambiguity checks and passes live authority", async () => {
  const respond = await invoke("toolUsage.import", { agentId: "work", dryRun: true });
  expect(mocks.inventory).toHaveBeenCalledWith({
    cfg: config,
    agentId: "work",
    agentRuntime: "openclaw",
  });
  expect(mocks.import).toHaveBeenCalledWith({
    agentId: "work",
    config,
    sinceDays: 90,
    dryRun: true,
    catalog: [
      { id: "openclaw:core:read", name: "read" },
      { id: "openclaw:memory:remember", name: "remember" },
      { id: "mcp:bundle-mcp:remote", name: "remote" },
    ],
    assertCurrent: expect.any(Function),
  });
  expect(respond).toHaveBeenCalledWith(true, {
    agentId: "work",
    successfulCalls: 2,
    scannedEvents: 5,
    dryRun: true,
    rowCount: 0,
    top: [],
  });
});

it("does not start import when authority expires during catalog preparation", async () => {
  let current = true;
  mocks.inventory.mockImplementation(async () => {
    current = false;
    return { groups: [] };
  });
  const respond = await invoke("toolUsage.import", {}, () => current);
  expect(mocks.import).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );
});

it("delegates reset to the owner that invalidates pending generations", async () => {
  const respond = await invoke("toolUsage.reset", { agentId: "work" });
  expect(mocks.reset).toHaveBeenCalledWith({
    agentId: "work",
    config,
    assertCurrent: expect.any(Function),
  });
  expect(respond).toHaveBeenCalledWith(true, { agentId: "work", reset: true, generation: 2 });
});

it.each([
  ["toolUsage.import", { sinceDays: 0 }],
  ["toolUsage.import", { dryRun: "true" }],
  ["toolUsage.status", { limit: 101 }],
  ["toolUsage.reset", { unexpected: true }],
  ["toolUsage.reset", { agentId: "missing" }],
])("rejects invalid %s requests before persistence", async (method, params) => {
  const respond = await invoke(method, params);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.import).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
});
