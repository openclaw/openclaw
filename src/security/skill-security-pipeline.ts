import path from "node:path";
import { sha256Bytes } from "./hash-skill.js";
import { buildDefaultSkillBundlePath, createDeterministicSkillBundle } from "./package-skill.js";
import { mapVerdictToAction, type SkillSecurityPolicyConfig } from "./policy.js";
import type { SkillSecurityScanner } from "./scanners/base.js";
import {
  appendSkillSecurityAudit,
  createEmptySkillSecurityStore,
  recordSkillScanResult,
  upsertSkillVersionRecord,
} from "./skill-security-store.js";
import type {
  SkillSecurityPackageMetadata,
  SkillSecurityPolicyDecision,
  SkillSecurityPublisherMetadata,
  SkillSecurityScanRecord,
  SkillSecurityStore,
  SkillSecurityVersionRecord,
} from "./skill-security-types.js";

export type SkillSecurityPipelineResult = {
  metadata: SkillSecurityPackageMetadata;
  packageHashSha256: string;
  bundlePath: string;
  scan: SkillSecurityScanRecord;
  policy: SkillSecurityPolicyDecision;
  versionRecord: SkillSecurityVersionRecord;
  store: SkillSecurityStore;
};

export async function evaluateSkillPackageForTrust(params: {
  skillDir: string;
  skillName: string;
  version: string;
  publisher: SkillSecurityPublisherMetadata;
  scanner: SkillSecurityScanner;
  policyConfig?: SkillSecurityPolicyConfig;
  store?: SkillSecurityStore;
  outputPath?: string;
  actor?: string | null;
  createdAt?: string;
}): Promise<SkillSecurityPipelineResult> {
  const outputPath =
    params.outputPath ?? buildDefaultSkillBundlePath({ skillName: params.skillName, version: params.version });
  const packaged = await createDeterministicSkillBundle({
    skillDir: params.skillDir,
    skillName: params.skillName,
    version: params.version,
    publisher: params.publisher,
    createdAt: params.createdAt,
    outputPath,
  });
  const packageHashSha256 = sha256Bytes(packaged.bundle);
  const metadata = {
    ...packaged.metadata,
    packageHashSha256,
  };
  const store = params.store ?? createEmptySkillSecurityStore();
  const versionRecord = upsertSkillVersionRecord({
    store,
    metadata,
    packageHashSha256,
    publisher: params.publisher,
    bundlePath: packaged.bundlePath ?? outputPath,
    active: true,
  });

  appendSkillSecurityAudit(store, {
    ts: new Date().toISOString(),
    actor: params.actor ?? null,
    skillName: params.skillName,
    version: params.version,
    packageHashSha256,
    event: "packaged",
    detail: `Packaged skill from ${path.resolve(params.skillDir)} into ${outputPath}`,
  });

  const scan = await params.scanner.submitPackage({
    bundlePath: outputPath,
    packageHashSha256,
    metadata,
  });
  const policy = mapVerdictToAction({
    verdict: scan.verdict,
    confidence: scan.confidence,
    metadata,
    config: params.policyConfig,
  });

  recordSkillScanResult({
    store,
    skillName: params.skillName,
    version: params.version,
    scan,
    latestPolicyAction: policy.action,
  });

  appendSkillSecurityAudit(store, {
    ts: scan.scannedAt,
    actor: params.actor ?? null,
    skillName: params.skillName,
    version: params.version,
    packageHashSha256,
    event: "scanned",
    detail: `Provider=${scan.provider}; verdict=${scan.verdict}; action=${policy.action}`,
  });
  appendSkillSecurityAudit(store, {
    ts: policy.decidedAt,
    actor: params.actor ?? null,
    skillName: params.skillName,
    version: params.version,
    packageHashSha256,
    event: "policy_decision",
    detail: policy.reasons.join(" "),
  });

  return {
    metadata,
    packageHashSha256,
    bundlePath: outputPath,
    scan,
    policy,
    versionRecord,
    store,
  };
}
