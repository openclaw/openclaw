import { mapVerdictToAction, type SkillSecurityPolicyConfig } from "../security/policy.js";
import type { SkillSecurityScanner } from "../security/scanners/base.js";
import { appendSkillSecurityAudit, recordSkillScanResult } from "../security/skill-security-store.js";
import type {
  SkillSecurityPolicyDecision,
  SkillSecurityStore,
  SkillSecurityVerdict,
} from "../security/skill-security-types.js";

const VERDICT_RANK: Record<SkillSecurityVerdict, number> = {
  benign: 0,
  unknown: 1,
  error: 1,
  suspicious: 2,
  malicious: 3,
};

export type RescanSkillsJobResult = {
  processed: number;
  rescanned: number;
  warnings: string[];
};

export async function runSkillRescanJob(params: {
  store: SkillSecurityStore;
  scanner: SkillSecurityScanner;
  policyConfig?: SkillSecurityPolicyConfig;
  actor?: string | null;
}): Promise<RescanSkillsJobResult> {
  let processed = 0;
  let rescanned = 0;
  const warnings: string[] = [];

  for (const packageRecord of params.store.packages) {
    for (const versionRecord of packageRecord.versions) {
      if (!versionRecord.active) {
        continue;
      }
      processed += 1;
      const previousVerdict = versionRecord.latestVerdict;
      const lookup = await params.scanner.lookupByHash(versionRecord.packageHashSha256);
      let scan = lookup.record;
      if (!scan && versionRecord.bundlePath) {
        scan = await params.scanner.submitPackage({
          bundlePath: versionRecord.bundlePath,
          packageHashSha256: versionRecord.packageHashSha256,
          metadata: versionRecord.metadata,
        });
      }
      if (!scan) {
        warnings.push(
          `Missing scan record and bundle path for ${packageRecord.skillName}@${versionRecord.version}`,
        );
        continue;
      }

      const rescannedRecord = {
        ...scan,
        scannedAt: new Date().toISOString(),
        lastRescannedAt: new Date().toISOString(),
      };
      const policy: SkillSecurityPolicyDecision = mapVerdictToAction({
        verdict: rescannedRecord.verdict,
        confidence: rescannedRecord.confidence,
        metadata: versionRecord.metadata,
        config: params.policyConfig,
      });
      recordSkillScanResult({
        store: params.store,
        skillName: packageRecord.skillName,
        version: versionRecord.version,
        scan: rescannedRecord,
        latestPolicyAction: policy.action,
        rescanned: true,
      });
      rescanned += 1;

      appendSkillSecurityAudit(params.store, {
        ts: rescannedRecord.scannedAt,
        actor: params.actor ?? null,
        skillName: packageRecord.skillName,
        version: versionRecord.version,
        packageHashSha256: versionRecord.packageHashSha256,
        event: "rescanned",
        detail: `Provider=${rescannedRecord.provider}; verdict=${rescannedRecord.verdict}; action=${policy.action}`,
      });

      if (VERDICT_RANK[rescannedRecord.verdict] > VERDICT_RANK[previousVerdict]) {
        const warning = `Verdict downgrade for ${packageRecord.skillName}@${versionRecord.version}: ${previousVerdict} -> ${rescannedRecord.verdict}`;
        warnings.push(warning);
        appendSkillSecurityAudit(params.store, {
          ts: rescannedRecord.scannedAt,
          actor: params.actor ?? null,
          skillName: packageRecord.skillName,
          version: versionRecord.version,
          packageHashSha256: versionRecord.packageHashSha256,
          event: "downgrade_warning",
          detail: warning,
        });
      }
    }
  }

  return { processed, rescanned, warnings };
}
