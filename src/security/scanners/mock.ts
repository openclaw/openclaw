import fs from "node:fs/promises";
import JSZip from "jszip";
import { scanSource } from "../skill-scanner.js";
import type {
  SkillSecurityScanRecord,
  SkillSecurityScannerFinding,
  SkillSecurityVerdict,
} from "../skill-security-types.js";
import type { SkillSecurityScanner, SkillScannerLookupResult, SkillScannerSubmitParams } from "./base.js";

const verdictConfidence: Record<SkillSecurityVerdict, number> = {
  benign: 0.9,
  suspicious: 0.7,
  malicious: 0.95,
  unknown: 0.4,
  error: 0.1,
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildScanId(hash: string): string {
  return `mock:${hash.slice(0, 16)}`;
}

function summarizeFindings(findings: SkillSecurityScannerFinding[]): string {
  if (findings.length === 0) {
    return "No suspicious patterns detected in packaged skill files.";
  }
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warn = findings.filter((finding) => finding.severity === "warn").length;
  const info = findings.filter((finding) => finding.severity === "info").length;
  return `Mock scanner findings: critical=${critical}, warn=${warn}, info=${info}`;
}

function normalizeFindings(rawFindings: ReturnType<typeof scanSource>): SkillSecurityScannerFinding[] {
  return rawFindings.map((finding) => ({
    ruleId: finding.ruleId,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    message: finding.message,
    evidence: finding.evidence,
  }));
}

function deriveVerdict(findings: SkillSecurityScannerFinding[]): SkillSecurityVerdict {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "malicious";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "suspicious";
  }
  if (findings.some((finding) => finding.severity === "info")) {
    return "benign";
  }
  return "benign";
}

export class MockSkillScanner implements SkillSecurityScanner {
  readonly provider = "mock" as const;

  private readonly scansByHash = new Map<string, SkillSecurityScanRecord>();
  private readonly scansById = new Map<string, SkillSecurityScanRecord>();

  normalizeVerdict(raw: unknown): SkillSecurityVerdict {
    if (raw === "benign" || raw === "suspicious" || raw === "malicious") {
      return raw;
    }
    if (raw === "unknown" || raw === "error") {
      return raw;
    }
    return "unknown";
  }

  async lookupByHash(hash: string): Promise<SkillScannerLookupResult> {
    const record = this.scansByHash.get(hash) ?? null;
    return { found: record !== null, record };
  }

  async getScanResult(scanId: string): Promise<SkillSecurityScanRecord | null> {
    return this.scansById.get(scanId) ?? null;
  }

  async submitPackage(params: SkillScannerSubmitParams): Promise<SkillSecurityScanRecord> {
    const cached = this.scansByHash.get(params.packageHashSha256);
    if (cached) {
      return cached;
    }

    const bundle = await fs.readFile(params.bundlePath);
    const zip = await JSZip.loadAsync(bundle);
    const findings: SkillSecurityScannerFinding[] = [];

    for (const [entryName, entry] of Object.entries(zip.files).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (entry.dir || entryName === "_meta.json") {
        continue;
      }
      if (!/\.(c|m)?tsx?$|\.jsx?$/.test(entryName)) {
        continue;
      }
      const source = await entry.async("string");
      findings.push(...normalizeFindings(scanSource(source, entryName)));
    }

    const verdict = deriveVerdict(findings);
    const scannedAt = nowIso();
    const record: SkillSecurityScanRecord = {
      provider: this.provider,
      scanId: buildScanId(params.packageHashSha256),
      status: "complete",
      verdict,
      confidence: verdictConfidence[verdict],
      packageHashSha256: params.packageHashSha256,
      scannedAt,
      lastRescannedAt: null,
      reportUrl: null,
      findings,
      summary: summarizeFindings(findings),
      raw: {
        metadataSkillName: params.metadata?.skillName ?? null,
        fileCount: Object.keys(zip.files).length,
      },
    };

    this.scansByHash.set(params.packageHashSha256, record);
    this.scansById.set(record.scanId ?? buildScanId(params.packageHashSha256), record);
    return record;
  }
}
