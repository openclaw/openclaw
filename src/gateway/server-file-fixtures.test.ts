import { expect, it, vi } from "vitest";

async function loadFixtures() {
  const [runtime, plugins] = await Promise.all([
    import("./test-helpers.runtime-state.js"),
    import("./test-helpers.plugin-registry.js"),
  ]);
  return { runtime, plugins };
}

it("preserves Gateway fixture identity within a file and retires state before the next file", async () => {
  const initialState = expect.getState();
  const fileContext = vi.spyOn(expect, "getState").mockReturnValue({
    ...initialState,
    testPath: `${initialState.testPath}.first`,
  });
  try {
    vi.resetModules();
    const first = await loadFixtures();
    const firstRegistry = first.plugins.getTestPluginRegistry();
    first.runtime.testState.sessionStorePath = "first-file.sqlite";
    first.runtime.testConfigRoot.value = "first-file-config";
    first.runtime.embeddedRunMock.activeIds.add("first-file-run");
    first.runtime.dispatchInboundMessageMock.mockResolvedValue("first-file-dispatch");
    first.runtime
      .getGatewayTestHoistedState()
      .runBtwSideQuestion.mockResolvedValue("first-file-btw");
    firstRegistry.channels = [];
    firstRegistry.speechProviders = [];

    vi.resetModules();
    const reloaded = await loadFixtures();
    expect(reloaded.runtime.testState).toBe(first.runtime.testState);
    expect(reloaded.runtime.testConfigRoot).toBe(first.runtime.testConfigRoot);
    expect(reloaded.runtime.dispatchInboundMessageMock).toBe(
      first.runtime.dispatchInboundMessageMock,
    );
    expect(reloaded.plugins.getTestPluginRegistry()).toBe(firstRegistry);
    expect(reloaded.runtime.testState.sessionStorePath).toBe("first-file.sqlite");
    await expect(reloaded.runtime.dispatchInboundMessageMock()).resolves.toBe(
      "first-file-dispatch",
    );

    fileContext.mockReturnValue({
      ...initialState,
      testPath: `${initialState.testPath}.next`,
    });
    vi.resetModules();
    const next = await loadFixtures();
    expect(next.runtime.testState).not.toBe(first.runtime.testState);
    expect(next.runtime.testState.sessionStorePath).toBeUndefined();
    expect(next.runtime.testConfigRoot.value).not.toBe("first-file-config");
    expect(next.runtime.embeddedRunMock.activeIds.size).toBe(0);
    expect(next.runtime.dispatchInboundMessageMock.getMockImplementation()).toBeUndefined();
    expect(next.runtime.dispatchInboundMessageMock).not.toHaveBeenCalled();
    await expect(
      next.runtime.getGatewayTestHoistedState().runBtwSideQuestion(),
    ).resolves.toBeUndefined();
    expect(next.plugins.getTestPluginRegistry()).not.toBe(firstRegistry);
    expect(next.plugins.getTestPluginRegistry().channels.length).toBeGreaterThan(0);
    expect(next.plugins.getTestPluginRegistry().speechProviders.length).toBeGreaterThan(0);
  } finally {
    fileContext.mockRestore();
    vi.resetModules();
    await loadFixtures();
  }
});
