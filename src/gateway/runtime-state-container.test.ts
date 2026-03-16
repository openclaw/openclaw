import { describe, expect, it, vi } from "vitest";

const activateSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const getActiveSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const clearSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../secrets/runtime.js", () => ({
  activateSecretsRuntimeSnapshot: activateSecretsRuntimeSnapshotMock,
  getActiveSecretsRuntimeSnapshot: getActiveSecretsRuntimeSnapshotMock,
  clearSecretsRuntimeSnapshot: clearSecretsRuntimeSnapshotMock,
}));

const { createGlobalRuntimeStateContainer } = await import("./runtime-state-container.js");

describe("gateway runtime state container", () => {
  it("adapts secrets runtime operations to the global secrets runtime module", () => {
    const container = createGlobalRuntimeStateContainer();
    const snapshot = { config: {}, sourceConfig: {}, authStores: [], warnings: [], webTools: {} };
    const expectedActive = { id: "active-snapshot" };
    getActiveSecretsRuntimeSnapshotMock.mockReturnValueOnce(expectedActive);

    container.secretsRuntime.activate(snapshot as never);
    const active = container.secretsRuntime.getActive();
    container.secretsRuntime.clear();

    expect(activateSecretsRuntimeSnapshotMock).toHaveBeenCalledWith(snapshot);
    expect(getActiveSecretsRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
    expect(active).toBe(expectedActive);
    expect(clearSecretsRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
