/** Doctor-only detection result for one retired client identity JSON. */
export type LegacyDeviceIdentitySource = {
  identityKey: "primary" | "node" | "shareExtension";
  sourcePath: string;
  claimPath: string;
  nativeClaimPath: string;
  hasLegacy: boolean;
  hasInvalidCanonical: boolean;
};

export type LegacyDeviceIdentityDetection = {
  sources: LegacyDeviceIdentitySource[];
  hasLegacy: boolean;
  hasInvalidCanonical: boolean;
};
