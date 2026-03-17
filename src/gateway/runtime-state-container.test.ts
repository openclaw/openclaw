import { describe, expect, it, vi } from "vitest";

const activateSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const getActiveSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const clearSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const setFallbackGatewayContextMock = vi.hoisted(() => vi.fn());
const getFallbackGatewayContextMock = vi.hoisted(() => vi.fn());
const clearFallbackGatewayContextMock = vi.hoisted(() => vi.fn());

vi.mock("../secrets/runtime.js", () => ({
  activateSecretsRuntimeSnapshot: activateSecretsRuntimeSnapshotMock,
  getActiveSecretsRuntimeSnapshot: getActiveSecretsRuntimeSnapshotMock,
  clearSecretsRuntimeSnapshot: clearSecretsRuntimeSnapshotMock,
}));

vi.mock("./server-plugins.js", () => ({
  setFallbackGatewayContext: setFallbackGatewayContextMock,
  getFallbackGatewayContext: getFallbackGatewayContextMock,
  clearFallbackGatewayContext: clearFallbackGatewayContextMock,
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

  it("adapts fallback gateway context operations to the global plugin dispatch module", () => {
    const container = createGlobalRuntimeStateContainer();
    const fallbackContext = { user: { id: "operator" } };
    const expectedActive = { user: { id: "active" } };
    getFallbackGatewayContextMock.mockReturnValueOnce(expectedActive);

    container.fallbackGatewayContext.set(fallbackContext as never);
    const active = container.fallbackGatewayContext.get();
    container.fallbackGatewayContext.clear();

    expect(setFallbackGatewayContextMock).toHaveBeenCalledWith(fallbackContext);
    expect(getFallbackGatewayContextMock).toHaveBeenCalledTimes(1);
    expect(active).toBe(expectedActive);
    expect(clearFallbackGatewayContextMock).toHaveBeenCalledTimes(1);
  });
});
