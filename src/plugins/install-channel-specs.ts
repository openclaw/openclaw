// Parses channel-oriented plugin install specs from package inputs.
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import {
  resolveExtendedStablePluginTarget,
  type ExtendedStablePluginTargetCode,
  type ExtendedStablePluginTargetContext,
} from "./extended-stable-plugin-target.js";

export type ChannelInstallSpecs = {
  installSpec: string;
  recordSpec: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
  targetCode?: ExtendedStablePluginTargetCode;
};

function isDefaultNpmSpecForBetaChannel(spec: string): { name: string } | null {
  const parsed = parseRegistryNpmSpec(spec);
  if (!parsed) {
    return null;
  }
  if (parsed.selectorKind === "none") {
    return { name: parsed.name };
  }
  if (parsed.selectorKind === "tag" && parsed.selector?.toLowerCase() === "latest") {
    return { name: parsed.name };
  }
  return null;
}

function isDefaultClawHubSpecForBetaChannel(spec: string): { name: string } | null {
  const parsed = parseClawHubPluginSpec(spec);
  if (!parsed) {
    return null;
  }
  if (!parsed.version || parsed.version.toLowerCase() === "latest") {
    return { name: parsed.name };
  }
  return null;
}

export function resolveNpmInstallSpecsForUpdateChannel(params: {
  spec: string;
  updateChannel?: UpdateChannel;
  officialPackageName?: string;
  extendedStableTargetContext?: ExtendedStablePluginTargetContext;
}): ChannelInstallSpecs {
  if (
    params.updateChannel === "extended-stable" &&
    params.officialPackageName &&
    !params.extendedStableTargetContext
  ) {
    throw new Error("extended-stable official plugin targeting requires packaged metadata");
  }
  if (
    params.updateChannel === "extended-stable" &&
    params.officialPackageName &&
    params.extendedStableTargetContext
  ) {
    const decision = resolveExtendedStablePluginTarget({
      requestedSpec: params.spec,
      officialPackageName: params.officialPackageName,
      updateChannel: params.updateChannel,
      ...params.extendedStableTargetContext,
    });
    if (decision.kind !== "unchanged") {
      return {
        installSpec: decision.installSpec,
        recordSpec: decision.recordSpec,
        targetCode: decision.code,
      };
    }
  }
  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = isDefaultNpmSpecForBetaChannel(params.spec);
  if (!betaTarget) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaSpec = `${betaTarget.name}@beta`;
  return {
    installSpec: betaSpec,
    recordSpec: params.spec,
    fallbackSpec: params.spec,
    fallbackLabel: betaSpec,
  };
}

export function resolveClawHubInstallSpecsForUpdateChannel(params: {
  spec: string;
  updateChannel?: UpdateChannel;
}): ChannelInstallSpecs {
  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = isDefaultClawHubSpecForBetaChannel(params.spec);
  if (!betaTarget) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaSpec = `clawhub:${betaTarget.name}@beta`;
  return {
    installSpec: betaSpec,
    recordSpec: params.spec,
    fallbackSpec: params.spec,
    fallbackLabel: betaSpec,
  };
}
