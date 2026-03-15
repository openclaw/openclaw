import { describe, expect, it } from "vitest";
import { runSkillRescanJob } from "./rescan-skills.js";
import type { SkillSecurityScanner } from "../security/scanners/base.js";
import { createEmptySkillSecurityStore, upsertSkillVersionRecord } from "../security/skill-security-store.js";
import type { SkillSecurityScanRecord } from "../security/skill-security-types.js";

describe("runSkillRescanJob", () => {
  it("emits a warning when a verdict is downgraded", async () => {
    const store = createEmptySkillSecurityStore();
    upsertSkillVersionRecord({
      store,
      metadata: {
        formatVersion: 1,
        skillName: "demo",
        version: "1.0.0",
        publisher: { publisherId: "radar" },
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceFiles: ["index.ts"],
        packageHashSha256: "abc",
        packaging: { ordering: "lexical", compression: "STORE", timestamp: "2026-01-01T00:00:00.000Z" },
      },
      packageHashSha256: "abc",
      publisher: { publisherId: "radar" },
      bundlePath: "/tmp/demo.zip",
      active: true,
    });
    store.packages[0]!.versions[0]!.latestVerdict = "benign";

    const downgradedScan: SkillSecurityScanRecord = {
      provider: "mock",
      scanId: "mock:abc",
      status: "complete",
      verdict: "suspicious",
      confidence: 0.8,
      packageHashSha256: "abc",
      scannedAt: new Date().toISOString(),
      lastRescannedAt: null,
      reportUrl: null,
      findings: [],
      summary: "suspicious",
      raw: null,
    };
    const scanner: SkillSecurityScanner = {
      provider: "mock",
      async submitPackage() {
        return downgradedScan;
      },
      async lookupByHash() {
        return { found: true, record: downgradedScan };
      },
      async getScanResult() {
        return downgradedScan;
      },
      normalizeVerdict(raw) {
        return raw === "suspicious" ? "suspicious" : "unknown";
      },
    };

    const result = await runSkillRescanJob({ store, scanner });
    expect(result.warnings[0]).toContain("Verdict downgrade");
    expect(store.packages[0]!.versions[0]!.latestVerdict).toBe("suspicious");
  });
});
