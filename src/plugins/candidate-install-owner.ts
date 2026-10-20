type InstallOwner = { installOwner?: string; ambiguous?: true };

export function createPluginInstallOwnerMetadata(key: string, configurable: boolean) {
  const symbol = Symbol.for(key);
  function read(value: object): InstallOwner | undefined {
    return (value as { [symbol]?: InstallOwner })[symbol];
  }
  return {
    record: <T extends object>(
      value: T,
      installOwner: string | undefined,
      ambiguous = false,
    ): T => {
      if (installOwner || ambiguous) {
        Object.defineProperty(value, symbol, {
          configurable,
          enumerable: true,
          value: ambiguous ? { ambiguous: true } : { installOwner },
        });
      }
      return value;
    },
    resolve: (value: object): string | undefined => read(value)?.installOwner,
    isAmbiguous: (value: object): boolean => read(value)?.ambiguous === true,
  };
}

export const {
  record: recordPluginCandidateInstallOwner,
  resolve: resolvePluginCandidateInstallOwner,
  isAmbiguous: isPluginCandidateInstallOwnerAmbiguous,
} = createPluginInstallOwnerMetadata("openclaw.pluginCandidateInstallOwner", true);
