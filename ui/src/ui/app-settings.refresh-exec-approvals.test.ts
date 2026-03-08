import { beforeEach, describe, expect, it, vi } from "vitest";

const loadNodes = vi.fn(async () => {});
const loadDevices = vi.fn(async () => {});
const loadConfig = vi.fn(async () => {});
const loadExecApprovals = vi.fn(async () => {});

vi.mock("./controllers/nodes.ts", () => ({
  loadNodes,
}));

vi.mock("./controllers/devices.ts", () => ({
  loadDevices,
}));

vi.mock("./controllers/config.ts", () => ({
  loadConfig,
  loadConfigSchema: vi.fn(async () => {}),
}));

vi.mock("./controllers/exec-approvals.ts", () => ({
  loadExecApprovals,
}));

const { refreshActiveTab } = await import("./app-settings.ts");

type RefreshHost = Parameters<typeof refreshActiveTab>[0] & {
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
};

function createHost(params?: { target?: "gateway" | "node"; nodeId?: string | null }): RefreshHost {
  return {
    tab: "nodes",
    execApprovalsTarget: params?.target ?? "gateway",
    execApprovalsTargetNodeId: params?.nodeId ?? null,
  } as RefreshHost;
}

describe("refreshActiveTab nodes approvals target", () => {
  beforeEach(() => {
    loadNodes.mockClear();
    loadDevices.mockClear();
    loadConfig.mockClear();
    loadExecApprovals.mockClear();
  });

  it("loads node approvals when node target is selected", async () => {
    const host = createHost({ target: "node", nodeId: "node-1" });

    await refreshActiveTab(host);

    expect(loadExecApprovals).toHaveBeenCalledWith(host, { kind: "node", nodeId: "node-1" });
  });

  it("loads gateway approvals when node target has no nodeId", async () => {
    const host = createHost({ target: "node", nodeId: null });

    await refreshActiveTab(host);

    expect(loadExecApprovals).toHaveBeenCalledWith(host, { kind: "gateway" });
  });

  it("loads gateway approvals when gateway target is selected", async () => {
    const host = createHost({ target: "gateway", nodeId: "node-1" });

    await refreshActiveTab(host);

    expect(loadExecApprovals).toHaveBeenCalledWith(host, { kind: "gateway" });
  });
});
