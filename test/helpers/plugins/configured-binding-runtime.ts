export async function createConfiguredBindingConversationRuntimeModuleMock(
  params: {
    ensureConfiguredBindingRouteReadyMock: (...args: unknown[]) => unknown;
    resolveConfiguredBindingRouteMock: (...args: unknown[]) => unknown;
  },
  importOriginal: () => Promise<{
    ensureConfiguredBindingRouteReady: (...args: unknown[]) => unknown;
    resolveConfiguredBindingRoute: (...args: unknown[]) => unknown;
  }>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
      params.ensureConfiguredBindingRouteReadyMock(...args),
    resolveConfiguredBindingRoute: (...args: unknown[]) =>
      params.resolveConfiguredBindingRouteMock(...args),
  };
}
