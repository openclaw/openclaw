export type NpmResolutionMetadata = {
  name?: string;
  version?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
};

export function resolvePinnedNpmSpec(params: {
  rawSpec: string;
  pin: boolean;
  resolvedSpec?: string;
}): { recordSpec: string; pinWarning?: string; pinNotice?: string } {
  const recordSpec = params.pin && params.resolvedSpec ? params.resolvedSpec : params.rawSpec;
  if (!params.pin) {
    return { recordSpec };
  }
  if (!params.resolvedSpec) {
    return {
      recordSpec,
      pinWarning: "Could not resolve exact npm version for --pin; storing original npm spec.",
    };
  }
  return {
    recordSpec,
    pinNotice: `Pinned npm install record to ${params.resolvedSpec}.`,
  };
}

export function mapNpmResolutionMetadata(resolution?: NpmResolutionMetadata): {
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
} {
  return {
    resolvedName: resolution?.name,
    resolvedVersion: resolution?.version,
    resolvedSpec: resolution?.resolvedSpec,
    integrity: resolution?.integrity,
    shasum: resolution?.shasum,
    resolvedAt: resolution?.resolvedAt,
  };
}

export function buildNpmInstallRecordFields(params: {
  spec: string;
  installPath: string;
  version?: string;
  resolution?: NpmResolutionMetadata;
}): {
  source: "npm";
  spec: string;
  installPath: string;
  version?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
} {
  return {
    source: "npm",
    spec: params.spec,
    installPath: params.installPath,
    version: params.version,
    ...mapNpmResolutionMetadata(params.resolution),
  };
}

export function logPinnedNpmSpecMessages(
  pinInfo: { pinWarning?: string; pinNotice?: string },
  log: (message: string) => void,
  logWarn: (message: string) => void,
): void {
  if (pinInfo.pinWarning) {
    logWarn(pinInfo.pinWarning);
  }
  if (pinInfo.pinNotice) {
    log(pinInfo.pinNotice);
  }
}
