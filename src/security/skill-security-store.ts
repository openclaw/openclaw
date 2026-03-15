import fs from "node:fs/promises";
import path from "node:path";
import type {
  SkillSecurityAuditEntry,
  SkillSecurityPackageMetadata,
  SkillSecurityPublisherMetadata,
  SkillSecurityScanRecord,
  SkillSecurityStore,
  SkillSecurityVersionRecord,
} from "./skill-security-types.js";

export function createEmptySkillSecurityStore(): SkillSecurityStore {
  return {
    version: 1,
    packages: [],
    auditTrail: [],
  };
}

export async function loadSkillSecurityStore(storePath: string): Promise<SkillSecurityStore> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    return JSON.parse(raw) as SkillSecurityStore;
  } catch {
    return createEmptySkillSecurityStore();
  }
}

export async function saveSkillSecurityStore(
  storePath: string,
  store: SkillSecurityStore,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

export function upsertSkillVersionRecord(params: {
  store: SkillSecurityStore;
  metadata: SkillSecurityPackageMetadata;
  packageHashSha256: string;
  publisher: SkillSecurityPublisherMetadata;
  bundlePath?: string | null;
  active?: boolean;
}): SkillSecurityVersionRecord {
  let packageRecord = params.store.packages.find((entry) => entry.skillName === params.metadata.skillName);
  if (!packageRecord) {
    packageRecord = {
      skillName: params.metadata.skillName,
      publisher: params.publisher,
      versions: [],
    };
    params.store.packages.push(packageRecord);
  }

  let versionRecord = packageRecord.versions.find(
    (entry) => entry.version === params.metadata.version || entry.packageHashSha256 === params.packageHashSha256,
  );
  if (!versionRecord) {
    versionRecord = {
      version: params.metadata.version,
      active: params.active ?? true,
      bundlePath: params.bundlePath ?? null,
      metadata: params.metadata,
      packageHashSha256: params.packageHashSha256,
      publisher: params.publisher,
      scans: [],
      latestVerdict: "unknown",
      latestPolicyAction: null,
      firstScannedAt: null,
      lastScannedAt: null,
      lastRescannedAt: null,
      externalReportUrl: null,
    };
    packageRecord.versions.push(versionRecord);
  }

  versionRecord.bundlePath = params.bundlePath ?? versionRecord.bundlePath ?? null;
  versionRecord.publisher = params.publisher;
  versionRecord.metadata = params.metadata;
  versionRecord.packageHashSha256 = params.packageHashSha256;
  versionRecord.active = params.active ?? versionRecord.active;
  return versionRecord;
}

export function recordSkillScanResult(params: {
  store: SkillSecurityStore;
  skillName: string;
  version: string;
  scan: SkillSecurityScanRecord;
  latestPolicyAction?: SkillSecurityVersionRecord["latestPolicyAction"];
  rescanned?: boolean;
}): SkillSecurityVersionRecord {
  const packageRecord = params.store.packages.find((entry) => entry.skillName === params.skillName);
  if (!packageRecord) {
    throw new Error(`unknown skill package: ${params.skillName}`);
  }
  const versionRecord = packageRecord.versions.find((entry) => entry.version === params.version);
  if (!versionRecord) {
    throw new Error(`unknown skill version: ${params.skillName}@${params.version}`);
  }

  versionRecord.scans.push(params.scan);
  versionRecord.latestVerdict = params.scan.verdict;
  versionRecord.latestPolicyAction = params.latestPolicyAction ?? versionRecord.latestPolicyAction;
  versionRecord.lastScannedAt = params.scan.scannedAt;
  versionRecord.firstScannedAt = versionRecord.firstScannedAt ?? params.scan.scannedAt;
  versionRecord.externalReportUrl = params.scan.reportUrl ?? versionRecord.externalReportUrl ?? null;
  if (params.rescanned) {
    versionRecord.lastRescannedAt = params.scan.scannedAt;
  }
  return versionRecord;
}

export function appendSkillSecurityAudit(
  store: SkillSecurityStore,
  entry: SkillSecurityAuditEntry,
): void {
  store.auditTrail.push(entry);
}
