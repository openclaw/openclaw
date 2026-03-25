export async function createConfiguredBindingConversationRuntimeModuleMock(
  params: {
    ensureConfiguredBindingRouteReadyMock: (...args: unknown[]) => unknown;
    resolveConfiguredBindingRouteMock: (...args: unknown[]) => unknown;
  },
  importOriginal: () => Promise<typeof import("openclaw/plugin-sdk/conversation-runtime")>,
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
