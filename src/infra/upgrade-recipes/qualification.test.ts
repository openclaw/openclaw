import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  classifyUpgradeChangedContracts,
  deriveUpgradeChangedContracts,
} from "../../../scripts/lib/upgrade-changed-contracts.mjs";
import { upgradeQualificationRecipeDigest } from "./qualification-recipe-digest.js";
import { validateUpgradeReleaseQualification } from "./qualification.js";
const mandatoryUpgradeQualificationCases = [
  "historical-transition",
  "dependency-closure",
  "old-config-loader-refusal",
  "missing-application-runtime",
  "legacy-recovery-owner-refusal",
  "modified-source-preserved",
  "unknown-source-refusal",
  "interrupted-migration-reconciliation",
  "protected-policy-preserved",
  "wrong-service-identity-refusal",
  "required-plugin-readiness",
  "post-admission-no-rewind",
  "corrupt-artifact-refusal",
  "unauthenticated-metadata-refusal",
  "expired-metadata-refusal",
  "rollback-metadata-refusal",
  "archive-traversal-refusal",
  "resource-substitution-refusal",
  "environment-injection-refusal",
  "rehearsal-live-state-and-egress-refusal",
  "custom-package-prefix",
  "split-cli-service-roots",
  "missing-custom-plugin-path",
  "stale-plugin-alias",
  "native-abi-mismatch",
  "package-lifecycle-script-refusal",
  "changed-package-manager-refusal",
  "unsupported-runtime-refusal",
  "database-wal",
  "corrupt-or-locked-store-refusal",
  "stale-plan-refusal",
  "disk-demand-per-filesystem",
  "failed-predecessor-readiness",
  "conflicting-recipe-selectors-refusal",
  "adapter-parameter-injection-refusal",
  "symlink-junction-replacement-refusal",
  "world-writable-staging-refusal",
  "malicious-extra-files-refusal",
  "wrong-service-account-refusal",
  "disk-full-fault",
  "permission-denial-fault",
  "process-identity-reuse-fault",
  "lease-loss-fault",
  "service-manager-restart-fault",
  "hanging-child-fault",
  "connection-loss-fault",
];
const mandatoryUpgradeCrashBoundaries = [
  "intent-persistence-before",
  "intent-persistence-after",
  "snapshot-completion-before",
  "snapshot-completion-after",
  "migration-commit-before",
  "migration-commit-after",
  "package-publication-before",
  "package-publication-after",
  "service-startup-before",
  "service-startup-after",
  "commit-intent-before",
  "commit-intent-after",
  "gate-release-before",
  "gate-release-after",
  "terminal-receipt-before",
  "terminal-receipt-after",
];
import type { UpgradeRecipeCatalog } from "./schema.js";

describe("release-owned change coverage", () => {
  it("requires runtime disposition even for a newly introduced unclassified owner", () => {
    expect(classifyUpgradeChangedContracts(["src/new-owner/new-contract.ts"])).toEqual(["runtime"]);
    expect(
      classifyUpgradeChangedContracts(["src/state/removed-owner.ts", "pnpm-lock.yaml"]),
    ).toEqual(["agent-db", "package", "runtime", "state-db"]);
  });

  it("refuses moving refs and option-shaped revisions before invoking git", () => {
    expect(() => deriveUpgradeChangedContracts("main", "a".repeat(40))).toThrow("immutable");
    expect(() => deriveUpgradeChangedContracts("a".repeat(40), "--help")).toThrow("immutable");
  });
});

function fixture() {
  const artifact = (id: string) => ({ id, sha256: "a".repeat(64), length: 100 });
  const platform = { os: "linux", arch: "x64", serviceMode: "systemd" } as const;
  const recipe: UpgradeRecipeCatalog["recipes"][number] = {
    schemaVersion: 1,
    purpose: "fixture",
    id: "recipe",
    revision: 1,
    summary: "Fixture only",
    catalogId: "fixture",
    source: {
      releaseIds: ["old"],
      identityClasses: ["verified-release"],
      stateContractClasses: ["legacy"],
      installKinds: ["npm"],
      platforms: [platform],
    },
    targetReleaseIds: ["new"],
    executor: { protocol: 1, requiredCapabilities: ["maintenance"] },
    steps: [
      {
        id: "step",
        adapter: {
          id: "adapter",
          revision: 1,
          bundleArtifactId: "adapter",
          parameterContractId: "empty",
        },
        phase: "verify",
        requires: [],
        resources: [{ kind: "configuration", scope: "active-profile", access: "read" }],
        parameters: {},
        mutation: "none",
        postconditionContractIds: ["policy"],
        recovery: { mode: "no-write", contractId: "recover", snapshotRequired: false },
      },
    ],
    safety: {
      requiresQuiescence: true,
      requiresMaintenanceGate: true,
      policyContractIds: ["policy"],
      rollbackContractId: "rollback",
      unattendedEligible: false,
    },
    qualificationIds: ["route"],
  };
  const catalog: UpgradeRecipeCatalog = {
    schemaVersion: 1,
    id: "fixture",
    artifacts: [
      "old",
      "new",
      "adapter",
      "runner",
      "bootstrap",
      "runtime",
      "fixture",
      "evidence",
      "diagnostics",
    ].map(artifact),
    releases: ["old", "new"].map((id) => ({
      id,
      version: "1",
      buildId: id,
      commit: "b".repeat(40),
      artifactId: id,
      runtimeFamily: "node",
      stateContracts: { state: 1, agent: 1 },
    })),
    recipes: [recipe],
    adapters: [
      {
        id: "adapter",
        revision: 1,
        bundleArtifactId: "adapter",
        parameterContractId: "empty",
        phases: ["verify"],
        parameterContract: "empty-object",
        inputStateContractClasses: ["legacy"],
        outputStateContractClass: "legacy",
      },
    ],
    qualifications: [
      {
        id: "route",
        recipe: { id: "recipe", revision: 1 },
        sourceReleaseId: "old",
        targetReleaseId: "new",
        installKind: "npm",
        platform,
        runtimeFamily: "node",
        stateContractClass: "legacy",
        evidenceArtifactId: "evidence",
      },
    ],
  };
  const route = {
    qualificationId: "route",
    recipeSha256: upgradeQualificationRecipeDigest(recipe),
    sourceArtifact: artifact("old"),
    targetArtifact: artifact("new"),
    adapterArtifacts: [artifact("adapter")],
    runnerArtifact: artifact("runner"),
    bootstrapArtifact: artifact("bootstrap"),
    runtimeArtifact: artifact("runtime"),
    fixtureArtifact: artifact("fixture"),
    cases: mandatoryUpgradeQualificationCases.map((name) => ({
      name,
      passed: true,
      diagnosticsArtifactId: "diagnostics",
    })),
    crashBoundaries: mandatoryUpgradeCrashBoundaries.map((name) => ({
      name,
      passed: true,
      diagnosticsArtifactId: "diagnostics",
    })),
  };
  return {
    catalog,
    recipe,
    route,
    evidence: { schemaVersion: 1, purpose: "fixture", routes: [route] },
    changedContracts: ["configuration"],
    dispositions: [
      {
        contractId: "configuration",
        disposition: "migration",
        rationale: "Reviewed fixture migration",
        qualificationIds: ["route"],
      },
    ],
    allowFixtures: true,
  };
}

describe("upgrade release qualification", () => {
  it("validates complete fixture evidence without authorizing production", () => {
    const input = fixture();
    expect(() => validateUpgradeReleaseQualification(input)).not.toThrow();
    expect(() => validateUpgradeReleaseQualification({ ...input, allowFixtures: false })).toThrow(
      /Fixture evidence/,
    );
  });
  it.each(["cases", "crashBoundaries"] as const)("rejects missing and failed %s", (key) => {
    const input = fixture();
    input.route[key].pop();
    expect(() => validateUpgradeReleaseQualification(input)).toThrow(/mandatory/);
    const failed = fixture();
    const first = failed.route[key][0];
    if (!first) {
      throw new Error("Missing fixture case");
    }
    first.passed = false;
    expect(() => validateUpgradeReleaseQualification(failed)).toThrow(/mandatory/);
  });
  it("binds recipe revision, parameters, artifact digests and installation class", () => {
    const changed = fixture();
    changed.recipe.summary = "Changed recipe bytes";
    expect(() => validateUpgradeReleaseQualification(changed)).toThrow(/Recipe digest/);
    const digest = fixture();
    digest.route.targetArtifact.sha256 = "c".repeat(64);
    expect(() => validateUpgradeReleaseQualification(digest)).toThrow(/binding mismatch/);
    const selector = fixture();
    selector.recipe.source.installKinds.push("pnpm");
    expect(() => validateUpgradeReleaseQualification(selector)).toThrow(
      /exact qualification coverage/,
    );
  });
  it("refuses production evidence that never identifies the qualified executor", () => {
    const input = fixture();
    input.recipe.purpose = "production";
    input.route.recipeSha256 = upgradeQualificationRecipeDigest(input.recipe);
    for (const release of input.catalog.releases) {
      release.installationManifestArtifactId = release.artifactId;
    }
    const production = {
      ...input,
      allowFixtures: false,
      evidence: { ...input.evidence, purpose: "historical-transition" },
    };
    expect(() => validateUpgradeReleaseQualification(production)).toThrow(/exact executor binding/);
    input.catalog.qualifications[0]!.executor = {
      runnerManifestArtifactId: "runner",
      runtimeArtifactId: "runtime",
      bootstrapArtifactId: "bootstrap",
    };
    expect(() => validateUpgradeReleaseQualification(production)).not.toThrow();
  });
  it("rejects evidence for a different catalog-valid executor", () => {
    const input = fixture();
    const qualification = input.catalog.qualifications[0]!;
    qualification.executor = {
      runnerManifestArtifactId: "runner",
      runtimeArtifactId: "runtime",
      bootstrapArtifactId: "bootstrap",
    };
    expect(() => validateUpgradeReleaseQualification(input)).not.toThrow();
    for (const field of ["runnerArtifact", "runtimeArtifact", "bootstrapArtifact"] as const) {
      const original = input.route[field];
      const other = { ...original, id: `${original.id}-other` };
      input.catalog.artifacts.push(other);
      input.route[field] = other;
      expect(() => validateUpgradeReleaseQualification(input)).toThrow(/binding mismatch/);
      input.route[field] = original;
    }
  });
  it("rejects missing contract disposition and missing migration coverage", () => {
    const input = fixture();
    expect(() => validateUpgradeReleaseQualification({ ...input, dispositions: [] })).toThrow(
      /disposition/,
    );
    input.dispositions[0]?.qualificationIds.pop();
    expect(() => validateUpgradeReleaseQualification(input)).toThrow(/coverage/);
  });
  it("rejects duplicate evidence, unknown diagnostics and missing adapter closure", () => {
    const duplicate = fixture();
    duplicate.evidence.routes.push(duplicate.route);
    expect(() => validateUpgradeReleaseQualification(duplicate)).toThrow(/Duplicate route/);
    const diagnostics = fixture();
    diagnostics.catalog.artifacts = diagnostics.catalog.artifacts.filter(
      (item) => item.id !== "diagnostics",
    );
    expect(() => validateUpgradeReleaseQualification(diagnostics)).toThrow(/diagnostics/);
    const adapter = fixture();
    adapter.route.adapterArtifacts = [];
    expect(() => validateUpgradeReleaseQualification(adapter)).toThrow(/adapter artifact/);
  });
  it("checks retained artifact bytes through the publication CLI and refuses corruption", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-qualification-"));
    try {
      const input = fixture();
      const artifactRoot = path.join(root, "artifacts");
      await fs.mkdir(artifactRoot);
      for (const artifact of input.catalog.artifacts) {
        const bytes = Buffer.from(`fixture bytes for ${artifact.id}`);
        artifact.length = bytes.length;
        artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
        await fs.writeFile(path.join(artifactRoot, artifact.id), bytes);
      }
      input.catalog.qualifications[0]!.executor = {
        runnerManifestArtifactId: "runner",
        runtimeArtifactId: "runtime",
        bootstrapArtifactId: "bootstrap",
      };
      const runtime = input.catalog.artifacts.find((item) => item.id === "runtime")!;
      const adapter = input.catalog.artifacts.find((item) => item.id === "adapter")!;
      const runnerIdentity = input.catalog.artifacts.find((item) => item.id === "runner")!;
      const manifest = {
        schemaVersion: 1,
        protocol: 1,
        platform: { os: "linux", arch: "x64" },
        runtime: { path: "node", kind: "node", version: "24.21.0" },
        entrypoint: "updater.mjs",
        bootstrapArtifactId: "bootstrap",
        externalModules: [],
        files: [
          {
            path: "node",
            artifactId: runtime.id,
            sha256: runtime.sha256,
            length: runtime.length,
            executable: true,
            role: "runtime",
          },
          {
            path: "updater.mjs",
            artifactId: adapter.id,
            sha256: adapter.sha256,
            length: adapter.length,
            executable: false,
            role: "runner",
          },
        ],
      };
      const writeRunnerManifest = async () => {
        const bytes = Buffer.from(JSON.stringify(manifest));
        runnerIdentity.length = bytes.length;
        runnerIdentity.sha256 = createHash("sha256").update(bytes).digest("hex");
        Object.assign(input.route.runnerArtifact, runnerIdentity);
        await fs.writeFile(path.join(artifactRoot, "runner"), bytes);
      };
      await writeRunnerManifest();
      for (const bound of [
        input.route.sourceArtifact,
        input.route.targetArtifact,
        input.route.runnerArtifact,
        input.route.bootstrapArtifact,
        input.route.runtimeArtifact,
        input.route.fixtureArtifact,
        ...input.route.adapterArtifacts,
      ]) {
        const expected = input.catalog.artifacts.find((item) => item.id === bound.id);
        if (!expected) {
          throw new Error("Missing fixture artifact");
        }
        Object.assign(bound, expected);
      }
      const writeEvidence = async () => {
        const evidenceBytes = Buffer.from(JSON.stringify(input.evidence));
        const evidenceArtifact = input.catalog.artifacts.find((item) => item.id === "evidence");
        if (!evidenceArtifact) {
          throw new Error("Missing fixture evidence artifact");
        }
        evidenceArtifact.length = evidenceBytes.length;
        evidenceArtifact.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
        await fs.writeFile(path.join(artifactRoot, "evidence"), evidenceBytes);
        await fs.writeFile(path.join(root, "evidence.json"), evidenceBytes);
        await fs.writeFile(path.join(root, "catalog.json"), JSON.stringify(input.catalog));
      };
      await writeEvidence();
      await fs.writeFile(path.join(root, "contracts.json"), JSON.stringify(input.changedContracts));
      await fs.writeFile(path.join(root, "dispositions.json"), JSON.stringify(input.dispositions));
      const args = [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/validate-upgrade-catalog.mts",
        "--catalog",
        path.join(root, "catalog.json"),
        "--evidence",
        path.join(root, "evidence.json"),
        "--artifacts-dir",
        artifactRoot,
        "--changed-contracts",
        path.join(root, "contracts.json"),
        "--dispositions",
        path.join(root, "dispositions.json"),
        "--fixture",
      ];
      const output = await promisify(execFile)(process.execPath, args);
      expect(JSON.parse(output.stdout)).toMatchObject({
        valid: true,
        qualifiedRoutes: 1,
        executionAuthority: false,
        authenticated: false,
      });
      manifest.bootstrapArtifactId = "runtime";
      await writeRunnerManifest();
      await writeEvidence();
      await expect(promisify(execFile)(process.execPath, args)).rejects.toThrow(
        /executor differs from its authenticated runner manifest/,
      );
      manifest.bootstrapArtifactId = "bootstrap";
      await writeRunnerManifest();
      await writeEvidence();
      const sourcePath = path.join(artifactRoot, "old");
      const bytes = await fs.readFile(sourcePath);
      bytes[0] = 0;
      await fs.writeFile(sourcePath, bytes);
      await expect(promisify(execFile)(process.execPath, args)).rejects.toThrow(
        /Artifact digest mismatch: old/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
