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

export function resolvePinnedNpmInstallRecord(params: {
  rawSpec: string;
  pin: boolean;
  installPath: string;
  version?: string;
  resolution?: NpmResolutionMetadata;
  log: (message: string) => void;
  warn: (message: string) => void;
}): ReturnType<typeof buildNpmInstallRecordFields> {
  const pinInfo = resolvePinnedNpmSpec({
    rawSpec: params.rawSpec,
    pin: params.pin,
    resolvedSpec: params.resolution?.resolvedSpec,
  });
  logPinnedNpmSpecMessages(pinInfo, params.log, params.warn);
  return buildNpmInstallRecordFields({
    spec: pinInfo.recordSpec,
    installPath: params.installPath,
    version: params.version,
    resolution: params.resolution,
  });
}

export function resolvePinnedNpmInstallRecordForCli(
  rawSpec: string,
  pin: boolean,
  installPath: string,
  version: string | undefined,
  resolution: NpmResolutionMetadata | undefined,
  log: (message: string) => void,
  warnFormat: (message: string) => string,
): ReturnType<typeof buildNpmInstallRecordFields> {
  return resolvePinnedNpmInstallRecord({
    rawSpec,
    pin,
    installPath,
    version,
    resolution,
    log,
    warn: (message) => log(warnFormat(message)),
  });
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
