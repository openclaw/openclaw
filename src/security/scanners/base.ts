import type {
  SkillScanProvider,
  SkillSecurityPackageMetadata,
  SkillSecurityScanRecord,
  SkillSecurityVerdict,
} from "../skill-security-types.js";

export type SkillScannerSubmitParams = {
  bundlePath: string;
  packageHashSha256: string;
  metadata?: SkillSecurityPackageMetadata;
};

export type SkillScannerLookupResult = {
  found: boolean;
  record: SkillSecurityScanRecord | null;
};

export interface SkillSecurityScanner {
  readonly provider: SkillScanProvider;
  submitPackage(params: SkillScannerSubmitParams): Promise<SkillSecurityScanRecord>;
  lookupByHash(hash: string): Promise<SkillScannerLookupResult>;
  getScanResult(scanId: string): Promise<SkillSecurityScanRecord | null>;
  normalizeVerdict(raw: unknown): SkillSecurityVerdict;
}
