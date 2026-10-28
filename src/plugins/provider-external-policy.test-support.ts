export function externalProviderPolicyRegistry(pluginRoot: string) {
  return {
    plugins: [
      {
        id: "fixture-provider",
        origin: "external",
        trustedOfficialInstall: true,
        rootDir: pluginRoot,
        providers: ["fixture-provider"],
        cliBackends: [],
      },
    ],
  };
}
