// Detects plugin version drift between config, manifests, and installs.
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import {
  computeStablePluginSupportDigest,
  validateStablePluginSupportManifest,
  type StablePluginSupportEntry,
  type StablePluginSupportManifest,
} from "./stable-plugin-support.js";

export type {
  StablePluginSupportEntry,
  StablePluginSupportManifest,
} from "./stable-plugin-support.js";

export type PluginVersionDriftEntry = {
  pluginId: string;
  installedVersion: string;
  gatewayVersion: string;
  source: PluginInstallRecord["source"];
  packageName?: string;
  spec?: string;
};

export type PluginVersionDriftReport = {
  gatewayVersion: string;
  drifts: PluginVersionDriftEntry[];
};

export type StablePluginLineMetadata = {
  stableLine: string;
  baseVersion?: string;
  targetBranch?: string;
  updatedAt?: string;
  manifestSha256?: string;
};

export type StablePluginRegistryProof = {
  packageName: string;
  version?: string;
  targetNpmSpec?: string;
  exists?: boolean;
  observedAt?: string;
};

export type StablePluginAcceptanceProof = {
  packageName: string;
  targetVersion?: string;
  targetNpmSpec?: string;
  stableLine?: string;
  stablePluginSupportSha256?: string;
  manifestSha256?: string;
  passed?: boolean;
  result?: "ok" | "pass" | "passed" | "success" | "failed" | "failure" | "error";
  completedAt?: string;
  generatedAt?: string;
  observedAt?: string;
};

export type StablePluginCatalogEntry = {
  packageName: string;
  pluginId: string;
  kind?: string;
  source?: string;
};

export type StablePluginInstalledEntry = {
  pluginId: string;
  packageName?: string;
  installedVersion?: string;
  resolvedVersion?: string;
  version?: string;
  spec?: string;
};

export type StablePluginDriftStatus =
  | "ok"
  | "registry_missing"
  | "proof_missing"
  | "proof_stale"
  | "installed_drift"
  | "catalog_drift"
  | "outside_stable_contract";

export type StablePluginDriftRow = {
  status: StablePluginDriftStatus;
  packageName: string;
  pluginId?: string;
  kind?: string;
  targetVersion?: string;
  targetNpmSpec?: string;
  targetBranch?: string;
  sourceRepository?: string;
  packageDir?: string;
  owners?: string[];
  registry?: {
    exists: boolean;
    observedVersion?: string;
    observedAt?: string;
  };
  proof?: {
    present: boolean;
    passed?: boolean;
    completedAt?: string;
    manifestSha256?: string;
  };
  installed?: {
    version?: string;
    spec?: string;
  };
  catalog?: {
    pluginId?: string;
    kind?: string;
    source?: string;
    matchesManifest: boolean;
  };
  reasons: string[];
};

export type StablePluginDriftIssueDecision = {
  idempotencyKey: string;
  marker: string;
  packageName: string;
  pluginId?: string;
  status: StablePluginDriftStatus;
  action: "none" | "dry_run_create_or_update" | "create_or_update" | "warn_only";
  owners: string[];
  title: string;
  body: string;
};

export type StablePluginDriftReport = {
  schemaVersion: 1;
  stableLine: string;
  generatedAt: string;
  manifestSha256: string;
  updateIssues: boolean;
  rows: StablePluginDriftRow[];
  issues: StablePluginDriftIssueDecision[];
  summary: {
    driftCount: number;
    blockingDriftCount: number;
    outsideStableContractCount: number;
  };
};

/**
 * Strip a trailing build qualifier (e.g. `2026.5.4-1` -> `2026.5.4`) so that
 * a gateway packaged as `2026.5.4-1` is not reported as drifted from a
 * plugin packaged as `2026.5.4`. Both ends are normalized identically.
 */
function normalizeVersion(value: string): string {
  return value.replace(/-\d+$/, "");
}

export function computeStablePluginSupportManifestSha256(
  manifest: StablePluginSupportManifest,
): string {
  return computeStablePluginSupportDigest(manifest);
}

export function parseStablePluginSupportManifest(raw: unknown): StablePluginSupportManifest {
  return validateStablePluginSupportManifest(raw).manifest;
}

function normalizeRegistryProofs(
  proofs: readonly StablePluginRegistryProof[],
): Map<string, StablePluginRegistryProof> {
  return new Map(proofs.map((proof) => [proof.packageName, proof]));
}

function normalizeAcceptanceProofs(
  proofs: readonly StablePluginAcceptanceProof[],
): Map<string, StablePluginAcceptanceProof> {
  return new Map(proofs.map((proof) => [proof.packageName, proof]));
}

function normalizeCatalogEntries(
  entries: readonly StablePluginCatalogEntry[],
): Map<string, StablePluginCatalogEntry> {
  return new Map(entries.map((entry) => [entry.packageName, entry]));
}

function normalizeInstalledEntries(
  entries: readonly StablePluginInstalledEntry[],
): StablePluginInstalledEntry[] {
  return entries.toSorted((left, right) =>
    (left.packageName ?? left.pluginId).localeCompare(right.packageName ?? right.pluginId),
  );
}

function proofPassed(proof: StablePluginAcceptanceProof | undefined): boolean {
  if (!proof) {
    return false;
  }
  if (proof.passed === true) {
    return true;
  }
  return (
    proof.result === "ok" ||
    proof.result === "pass" ||
    proof.result === "passed" ||
    proof.result === "success"
  );
}

function proofTimestamp(proof: StablePluginAcceptanceProof): string | undefined {
  return proof.completedAt ?? proof.generatedAt ?? proof.observedAt;
}

function proofManifestSha(proof: StablePluginAcceptanceProof): string | undefined {
  return proof.stablePluginSupportSha256 ?? proof.manifestSha256;
}

function isProofStale(params: {
  proof: StablePluginAcceptanceProof;
  manifestSha256: string;
  stableLine?: StablePluginLineMetadata;
  manifestUpdatedAt?: string;
}): boolean {
  const proofSha = proofManifestSha(params.proof);
  if (proofSha && proofSha !== params.manifestSha256) {
    return true;
  }
  const staleAfter = params.manifestUpdatedAt ?? params.stableLine?.updatedAt;
  const completedAt = proofTimestamp(params.proof);
  if (!staleAfter || !completedAt) {
    return false;
  }
  return Date.parse(completedAt) < Date.parse(staleAfter);
}

function installedVersion(entry: StablePluginInstalledEntry | undefined): string | undefined {
  return entry?.installedVersion ?? entry?.resolvedVersion ?? entry?.version;
}

function resolveCoveredRowStatus(params: {
  entry: StablePluginSupportEntry;
  registryProof?: StablePluginRegistryProof;
  proof?: StablePluginAcceptanceProof;
  catalogEntry?: StablePluginCatalogEntry;
  installedEntry?: StablePluginInstalledEntry;
  manifestSha256: string;
  stableLine?: StablePluginLineMetadata;
  manifestUpdatedAt?: string;
}): Pick<StablePluginDriftRow, "status" | "reasons"> {
  const reasons: string[] = [];
  const registryExists =
    params.registryProof?.exists === true &&
    params.registryProof.version === params.entry.targetVersion;
  if (!registryExists) {
    reasons.push(`registry target ${params.entry.targetNpmSpec} is missing or mismatched`);
    return { status: "registry_missing", reasons };
  }

  if (
    params.catalogEntry &&
    (params.catalogEntry.pluginId !== params.entry.pluginId ||
      params.catalogEntry.kind !== params.entry.kind)
  ) {
    reasons.push("official external catalog mapping no longer matches the manifest entry");
    return { status: "catalog_drift", reasons };
  }

  const observedInstalledVersion = installedVersion(params.installedEntry);
  if (
    observedInstalledVersion &&
    normalizeVersion(observedInstalledVersion) !== normalizeVersion(params.entry.targetVersion)
  ) {
    reasons.push(
      `installed version ${observedInstalledVersion} does not match ${params.entry.targetVersion}`,
    );
    return { status: "installed_drift", reasons };
  }

  if (!params.proof || !proofPassed(params.proof)) {
    reasons.push("stable package acceptance proof is missing or failing");
    return { status: "proof_missing", reasons };
  }

  if (
    params.proof.targetVersion &&
    normalizeVersion(params.proof.targetVersion) !== normalizeVersion(params.entry.targetVersion)
  ) {
    reasons.push("stable package acceptance proof targets a different package version");
    return { status: "proof_stale", reasons };
  }

  if (
    isProofStale({
      proof: params.proof,
      manifestSha256: params.manifestSha256,
      stableLine: params.stableLine,
      manifestUpdatedAt: params.manifestUpdatedAt,
    })
  ) {
    reasons.push("stable package acceptance proof predates active stable metadata or manifest");
    return { status: "proof_stale", reasons };
  }

  return { status: "ok", reasons: [] };
}

function buildIssueDecision(params: {
  stableLine: string;
  row: StablePluginDriftRow;
  updateIssues: boolean;
}): StablePluginDriftIssueDecision {
  const idempotencyKey = `${params.stableLine}:${params.row.packageName}`;
  const marker = `<!-- openclaw:stable-plugin-drift:${params.stableLine}:${params.row.packageName} -->`;
  const owners = params.row.owners ?? [];
  const blocking = params.row.status !== "ok" && params.row.status !== "outside_stable_contract";
  const action = blocking
    ? params.updateIssues
      ? "create_or_update"
      : "dry_run_create_or_update"
    : params.row.status === "outside_stable_contract"
      ? "warn_only"
      : "none";
  const bodyLines = [
    marker,
    "",
    `Stable line: ${params.stableLine}`,
    `Package: ${params.row.packageName}`,
    `Status: ${params.row.status}`,
    `Target: ${params.row.targetNpmSpec ?? "<outside stable contract>"}`,
    "",
    "Reasons:",
    ...(params.row.reasons.length > 0 ? params.row.reasons : ["none"]).map(
      (reason) => `- ${reason}`,
    ),
  ];
  return {
    idempotencyKey,
    marker,
    packageName: params.row.packageName,
    ...(params.row.pluginId ? { pluginId: params.row.pluginId } : {}),
    status: params.row.status,
    action,
    owners,
    title: `[stable-plugin-drift] ${params.row.packageName} ${params.row.status}`,
    body: bodyLines.join("\n"),
  };
}

export function generateStablePluginDriftReport(params: {
  manifest: StablePluginSupportManifest;
  stableLine?: StablePluginLineMetadata;
  registryProofs?: readonly StablePluginRegistryProof[];
  acceptanceProofs?: readonly StablePluginAcceptanceProof[];
  catalogEntries?: readonly StablePluginCatalogEntry[];
  installedEntries?: readonly StablePluginInstalledEntry[];
  manifestUpdatedAt?: string;
  generatedAt?: string;
  updateIssues?: boolean;
}): StablePluginDriftReport {
  const manifestSha256 = computeStablePluginSupportManifestSha256(params.manifest);
  const stableLine = params.stableLine?.stableLine ?? params.manifest.stableLine.baseVersion;
  const registryProofs = normalizeRegistryProofs(params.registryProofs ?? []);
  const acceptanceProofs = normalizeAcceptanceProofs(params.acceptanceProofs ?? []);
  const catalogEntries = normalizeCatalogEntries(params.catalogEntries ?? []);
  const installedEntries = normalizeInstalledEntries(params.installedEntries ?? []);
  const installedByPackage = new Map(
    installedEntries
      .filter((entry) => entry.packageName)
      .map((entry) => [entry.packageName as string, entry]),
  );
  const coveredPackageNames = new Set(
    params.manifest.coveredPlugins.map((entry) => entry.packageName),
  );
  const coveredPluginIds = new Set(params.manifest.coveredPlugins.map((entry) => entry.pluginId));

  const rows: StablePluginDriftRow[] = params.manifest.coveredPlugins.map((entry) => {
    const registryProof = registryProofs.get(entry.packageName);
    const proof = acceptanceProofs.get(entry.packageName);
    const catalogEntry = catalogEntries.get(entry.packageName);
    const installedEntry =
      installedByPackage.get(entry.packageName) ??
      installedEntries.find((candidate) => candidate.pluginId === entry.pluginId);
    const { status, reasons } = resolveCoveredRowStatus({
      entry,
      registryProof,
      proof,
      catalogEntry,
      installedEntry,
      manifestSha256,
      stableLine: params.stableLine,
      manifestUpdatedAt: params.manifestUpdatedAt,
    });

    const proofCompletedAt = proof ? proofTimestamp(proof) : undefined;
    const proofSha = proof ? proofManifestSha(proof) : undefined;
    const observedInstalledVersion = installedVersion(installedEntry);
    return {
      status,
      packageName: entry.packageName,
      pluginId: entry.pluginId,
      kind: entry.kind,
      targetVersion: entry.targetVersion,
      targetNpmSpec: entry.targetNpmSpec,
      targetBranch: entry.targetBranch,
      sourceRepository: entry.sourceRepository,
      packageDir: entry.packageDir,
      owners: entry.owners ?? [],
      registry: {
        exists: registryProof?.exists === true && registryProof.version === entry.targetVersion,
        ...(registryProof?.version ? { observedVersion: registryProof.version } : {}),
        ...(registryProof?.observedAt ? { observedAt: registryProof.observedAt } : {}),
      },
      proof: {
        present: Boolean(proof),
        ...(proof ? { passed: proofPassed(proof) } : {}),
        ...(proofCompletedAt ? { completedAt: proofCompletedAt } : {}),
        ...(proofSha ? { manifestSha256: proofSha } : {}),
      },
      ...(installedEntry
        ? {
            installed: {
              ...(observedInstalledVersion ? { version: observedInstalledVersion } : {}),
              ...(installedEntry.spec ? { spec: installedEntry.spec } : {}),
            },
          }
        : {}),
      ...(catalogEntry
        ? {
            catalog: {
              pluginId: catalogEntry.pluginId,
              ...(catalogEntry.kind ? { kind: catalogEntry.kind } : {}),
              ...(catalogEntry.source ? { source: catalogEntry.source } : {}),
              matchesManifest:
                catalogEntry.pluginId === entry.pluginId && catalogEntry.kind === entry.kind,
            },
          }
        : {}),
      reasons,
    };
  });

  for (const entry of installedEntries) {
    const packageName = entry.packageName ?? entry.pluginId;
    if (coveredPackageNames.has(packageName) || coveredPluginIds.has(entry.pluginId)) {
      continue;
    }
    rows.push({
      status: "outside_stable_contract",
      packageName,
      pluginId: entry.pluginId,
      installed: {
        ...(installedVersion(entry) ? { version: installedVersion(entry) } : {}),
        ...(entry.spec ? { spec: entry.spec } : {}),
      },
      reasons: ["installed plugin is not covered by the stable plugin support manifest"],
    });
  }

  rows.sort((left, right) => left.packageName.localeCompare(right.packageName));

  const updateIssues = params.updateIssues === true;
  const issues = rows.map((row) => buildIssueDecision({ stableLine, row, updateIssues }));
  const driftCount = rows.filter((row) => row.status !== "ok").length;
  const blockingDriftCount = rows.filter(
    (row) => row.status !== "ok" && row.status !== "outside_stable_contract",
  ).length;
  const outsideStableContractCount = rows.filter(
    (row) => row.status === "outside_stable_contract",
  ).length;

  return {
    schemaVersion: 1,
    stableLine,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    manifestSha256,
    updateIssues,
    rows,
    issues,
    summary: {
      driftCount,
      blockingDriftCount,
      outsideStableContractCount,
    },
  };
}

function isPluginEnabled(config: OpenClawConfig | undefined, pluginId: string): boolean {
  const normalizedPluginConfig = normalizePluginsConfig(config?.plugins);
  return resolveEffectiveEnableState({
    id: pluginId,
    origin: "global",
    config: normalizedPluginConfig,
    rootConfig: config,
  }).enabled;
}

function shouldCompareOfficialInstallToGateway(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): boolean {
  const officialNpmSpec = resolveTrustedSourceLinkedOfficialNpmSpec(params);
  if (officialNpmSpec) {
    return parseRegistryNpmSpec(officialNpmSpec)?.selectorKind !== "exact-version";
  }
  const officialClawHubInstall = resolveTrustedSourceLinkedOfficialClawHubInstall(params);
  if (officialClawHubInstall) {
    if (officialClawHubInstall.clawhubSpec) {
      return !parseClawHubPluginSpec(officialClawHubInstall.clawhubSpec)?.version;
    }
    return (
      parseRegistryNpmSpec(officialClawHubInstall.npmSpec ?? "")?.selectorKind !== "exact-version"
    );
  }
  return false;
}

/**
 * Compare active official external plugin installs against the running gateway
 * version and return any mismatches.
 *
 * @param params.gatewayVersion The gateway version string (typically the
 *   `version` field of the installed openclaw package.json).
 * @param params.installRecords The full set of recorded plugin installs (as
 *   produced by `loadInstalledPluginIndexInstallRecords`).
 * @param params.config The merged daemon-side OpenClawConfig (optional).
 *   Plugins inactive under the effective activation policy are skipped.
 *
 * The returned `drifts` list is sorted by `pluginId` for stable output.
 */
export function detectPluginVersionDrift(params: {
  gatewayVersion: string;
  installRecords: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
}): PluginVersionDriftReport {
  const { gatewayVersion, installRecords, config } = params;
  const normalizedGateway = normalizeVersion(gatewayVersion);
  const drifts: PluginVersionDriftEntry[] = [];

  for (const [pluginId, record] of Object.entries(installRecords)) {
    if (!record) {
      continue;
    }
    if (!isPluginEnabled(config, pluginId)) {
      continue;
    }
    if (
      !shouldCompareOfficialInstallToGateway({
        pluginId,
        record,
      })
    ) {
      continue;
    }
    const installedVersion = record.resolvedVersion ?? record.version;
    if (!installedVersion) {
      // No version recorded for this install — nothing to compare against.
      // Don't fabricate drift; surface tooling (status.print) can flag this
      // separately if desired.
      continue;
    }
    if (normalizeVersion(installedVersion) === normalizedGateway) {
      continue;
    }
    drifts.push({
      pluginId,
      installedVersion,
      gatewayVersion,
      source: record.source,
      ...(record.resolvedName ? { packageName: record.resolvedName } : {}),
      ...(record.spec ? { spec: record.spec } : {}),
    });
  }

  drifts.sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  return {
    gatewayVersion,
    drifts,
  };
}
