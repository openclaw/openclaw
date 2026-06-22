// Parses channel-oriented plugin install specs from package inputs.
import checkedInStablePluginSupportManifest from "../../release/stable-plugin-support.json" with { type: "json" };
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec, type ParsedRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { getOfficialExternalPluginCatalogEntryForPackage } from "./official-external-plugin-catalog.js";
import {
  FIRST_STABLE_PLUGIN_SUPPORT_PACKAGES,
  validateStablePluginSupportManifest,
  type StablePluginSupportEntry,
  type ValidatedStablePluginSupportManifest,
} from "./stable-plugin-support.js";

type StableAwareUpdateChannel = UpdateChannel | "daily";

export type ChannelInstallConvergenceReason =
  | "covered_stable_target"
  | "covered_daily_target"
  | "preserved_exact_pin"
  | "outside_stable_contract"
  | "third_party_preserved"
  | "disabled_or_blocked_preserved"
  | "missing_stable_target"
  | "ambiguous_exact_official_install";

export type StablePluginInstallClassification =
  | "explicit_user_pin"
  | "prior_default_intent_system_pin"
  | "unknown";

export type ChannelInstallSpecs = {
  installSpec: string;
  recordSpec: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
  reason?: ChannelInstallConvergenceReason;
  classification?: StablePluginInstallClassification;
  packageName?: string;
  stableLine?: string;
  manifestSha256?: string;
};

const DEFAULT_STABLE_PLUGIN_SUPPORT = validateStablePluginSupportManifest(
  checkedInStablePluginSupportManifest,
);

function isDefaultNpmSpecForChannel(spec: string): { name: string } | null {
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

function isDefaultNpmSpecParsed(parsed: ParsedRegistryNpmSpec): boolean {
  return (
    parsed.selectorKind === "none" ||
    (parsed.selectorKind === "tag" && parsed.selector?.toLowerCase() === "latest")
  );
}

function resolveStableManifestTarget(params: {
  packageName: string;
  stablePluginSupport?: ValidatedStablePluginSupportManifest;
}): StablePluginSupportEntry | undefined {
  const support = params.stablePluginSupport ?? DEFAULT_STABLE_PLUGIN_SUPPORT;
  return support.targetsByPackageName.get(params.packageName);
}

function resolveManifestSha256(stablePluginSupport?: ValidatedStablePluginSupportManifest): string {
  return (stablePluginSupport ?? DEFAULT_STABLE_PLUGIN_SUPPORT).stablePluginSupportSha256;
}

function isFirstStableCoveredPackageName(packageName: string): boolean {
  return (FIRST_STABLE_PLUGIN_SUPPORT_PACKAGES as readonly string[]).includes(packageName);
}

function isOfficialExternalPackage(packageName: string): boolean {
  return Boolean(getOfficialExternalPluginCatalogEntryForPackage(packageName));
}

function resolveInstallIntentClassification(
  record?: PluginInstallRecord,
): StablePluginInstallClassification {
  const recorded =
    record?.installIntentProvenance ?? record?.installIntentProvenanceMigration?.decision;
  if (recorded) {
    return recorded;
  }
  if (record?.source === "npm" && record.spec && isDefaultNpmSpecForChannel(record.spec)) {
    return "prior_default_intent_system_pin";
  }
  return "unknown";
}

function isExactCoveredOfficialSpec(parsed: ParsedRegistryNpmSpec): boolean {
  return parsed.selectorKind === "exact-version" && isFirstStableCoveredPackageName(parsed.name);
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
  updateChannel?: StableAwareUpdateChannel;
  record?: PluginInstallRecord;
  stablePluginSupport?: ValidatedStablePluginSupportManifest;
}): ChannelInstallSpecs {
  const parsed = parseRegistryNpmSpec(params.spec);
  if (params.updateChannel === "stable" || params.updateChannel === "daily") {
    return resolveStableAwareNpmInstallSpecsForUpdateChannel({
      spec: params.spec,
      parsed,
      updateChannel: params.updateChannel,
      record: params.record,
      stablePluginSupport: params.stablePluginSupport,
    });
  }

  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = isDefaultNpmSpecForChannel(params.spec);
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

function resolveStableAwareNpmInstallSpecsForUpdateChannel(params: {
  spec: string;
  parsed: ParsedRegistryNpmSpec | null;
  updateChannel: "stable" | "daily";
  record?: PluginInstallRecord;
  stablePluginSupport?: ValidatedStablePluginSupportManifest;
}): ChannelInstallSpecs {
  if (!params.parsed) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
      reason: "third_party_preserved",
    };
  }

  const packageName = params.parsed.name;
  const target = resolveStableManifestTarget({
    packageName,
    stablePluginSupport: params.stablePluginSupport,
  });
  const isDefaultIntent = isDefaultNpmSpecParsed(params.parsed);
  const isCoveredPackage = isFirstStableCoveredPackageName(packageName);
  const isOfficialPackage = isOfficialExternalPackage(packageName);

  if (params.updateChannel === "daily") {
    if (isDefaultIntent && target) {
      return {
        installSpec: params.spec,
        recordSpec: params.spec,
        reason: "covered_daily_target",
        packageName,
        stableLine: target.stableLine,
        manifestSha256: resolveManifestSha256(params.stablePluginSupport),
      };
    }
    return preserveStableAwareSpec({
      spec: params.spec,
      parsed: params.parsed,
      target,
      isOfficialPackage,
      updateChannel: params.updateChannel,
      record: params.record,
      stablePluginSupport: params.stablePluginSupport,
    });
  }

  if (isDefaultIntent) {
    if (target) {
      return {
        installSpec: target.targetNpmSpec,
        recordSpec: params.spec,
        reason: "covered_stable_target",
        packageName,
        stableLine: target.stableLine,
        manifestSha256: resolveManifestSha256(params.stablePluginSupport),
      };
    }
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
      reason: isCoveredPackage ? "missing_stable_target" : "outside_stable_contract",
      packageName,
      ...(isCoveredPackage
        ? {}
        : { manifestSha256: resolveManifestSha256(params.stablePluginSupport) }),
    };
  }

  if (isExactCoveredOfficialSpec(params.parsed)) {
    const classification = resolveInstallIntentClassification(params.record);
    if (classification === "prior_default_intent_system_pin") {
      if (!target) {
        return {
          installSpec: params.spec,
          recordSpec: params.spec,
          reason: "missing_stable_target",
          classification,
          packageName,
        };
      }
      return {
        installSpec: target.targetNpmSpec,
        recordSpec: params.record?.spec ?? packageName,
        reason: "covered_stable_target",
        classification,
        packageName,
        stableLine: target.stableLine,
        manifestSha256: resolveManifestSha256(params.stablePluginSupport),
      };
    }
    if (classification === "explicit_user_pin") {
      return {
        installSpec: params.spec,
        recordSpec: params.spec,
        reason: "preserved_exact_pin",
        classification,
        packageName,
      };
    }
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
      reason: "ambiguous_exact_official_install",
      classification,
      packageName,
    };
  }

  return preserveStableAwareSpec({
    spec: params.spec,
    parsed: params.parsed,
    target,
    isOfficialPackage,
    updateChannel: params.updateChannel,
    record: params.record,
    stablePluginSupport: params.stablePluginSupport,
  });
}

function preserveStableAwareSpec(params: {
  spec: string;
  parsed: ParsedRegistryNpmSpec;
  target?: StablePluginSupportEntry;
  isOfficialPackage: boolean;
  updateChannel: "stable" | "daily";
  record?: PluginInstallRecord;
  stablePluginSupport?: ValidatedStablePluginSupportManifest;
}): ChannelInstallSpecs {
  if (params.parsed.selectorKind === "exact-version") {
    const classification = resolveInstallIntentClassification(params.record);
    if (params.target) {
      if (classification === "explicit_user_pin") {
        return {
          installSpec: params.spec,
          recordSpec: params.spec,
          reason: "preserved_exact_pin",
          classification,
          packageName: params.parsed.name,
        };
      }
      if (
        classification === "prior_default_intent_system_pin" &&
        params.updateChannel === "daily"
      ) {
        return {
          installSpec: params.spec,
          recordSpec: params.record?.spec ?? params.spec,
          reason: "covered_daily_target",
          classification,
          packageName: params.parsed.name,
          stableLine: params.target.stableLine,
          manifestSha256: resolveManifestSha256(params.stablePluginSupport),
        };
      }
      return {
        installSpec: params.spec,
        recordSpec: params.spec,
        reason: "ambiguous_exact_official_install",
        classification,
        packageName: params.parsed.name,
      };
    }
    if (params.isOfficialPackage) {
      return {
        installSpec: params.spec,
        recordSpec: params.spec,
        reason: "outside_stable_contract",
        classification,
        packageName: params.parsed.name,
      };
    }
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
      reason: "third_party_preserved",
      classification,
      packageName: params.parsed.name,
    };
  }
  if (params.target) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
      reason:
        params.updateChannel === "daily"
          ? "covered_daily_target"
          : "ambiguous_exact_official_install",
      packageName: params.parsed.name,
      stableLine: params.target.stableLine,
      manifestSha256: resolveManifestSha256(params.stablePluginSupport),
    };
  }
  return {
    installSpec: params.spec,
    recordSpec: params.spec,
    reason: params.isOfficialPackage ? "outside_stable_contract" : "third_party_preserved",
    packageName: params.parsed.name,
  };
}

export function resolveClawHubInstallSpecsForUpdateChannel(params: {
  spec: string;
  updateChannel?: StableAwareUpdateChannel;
}): ChannelInstallSpecs {
  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
      ...(params.updateChannel === "stable" || params.updateChannel === "daily"
        ? { reason: "outside_stable_contract" as const }
        : {}),
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
