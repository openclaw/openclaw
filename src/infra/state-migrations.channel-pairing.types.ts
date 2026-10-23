export type LegacyChannelPairingStateDetection = {
  sourceDir: string;
  files: string[];
  knownChannelIds: string[];
  defaultAccountIds: Record<string, string>;
  accountIds: Record<string, string[]>;
  accountDiscoveryDeferred: boolean;
  hasLegacy: boolean;
};
