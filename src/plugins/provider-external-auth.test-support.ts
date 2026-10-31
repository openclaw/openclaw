export function createExternalAuthMock() {
  return {
    createProviderExternalAuthResolver: () => ({
      resolveExternalAuthProfilesWithPlugins: () => [],
      withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
    }),
  };
}
