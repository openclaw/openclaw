import { z } from "zod";
import { findQualifiedUpgradeRecipes, validateUpgradeRecipeCatalogReferences } from "./planner.js";
import { upgradeQualificationRecipeDigest } from "./qualification-recipe-digest.js";
import { upgradeRecipeCatalogSchema, type UpgradeRecipeCatalog } from "./schema.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.strictObject({
  id: z.string().min(1),
  sha256: digest,
  length: z.number().int().positive(),
});
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
] as const;
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
] as const;
const result = z.strictObject({
  name: z.string().min(1),
  passed: z.boolean(),
  diagnosticsArtifactId: z.string().min(1),
});
const upgradeQualificationEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.enum(["fixture", "historical-transition"]),
  routes: z.array(
    z.strictObject({
      qualificationId: z.string().min(1),
      recipeSha256: digest,
      sourceArtifact: binding,
      targetArtifact: binding,
      adapterArtifacts: z.array(binding),
      runnerArtifact: binding,
      bootstrapArtifact: binding,
      runtimeArtifact: binding,
      fixtureArtifact: binding,
      cases: z.array(result),
      crashBoundaries: z.array(result),
    }),
  ),
});
const upgradeMigrationDispositionsSchema = z.array(
  z.strictObject({
    contractId: z.string().min(1),
    disposition: z.enum(["unchanged", "compatible", "migration", "unsupported"]),
    rationale: z.string().min(1),
    qualificationIds: z.array(z.string().min(1)),
  }),
);

/** Release evidence validation is not metadata authentication or execution authority. */
export function validateUpgradeReleaseQualification(options: {
  catalog: UpgradeRecipeCatalog;
  evidence: unknown;
  changedContracts: string[];
  dispositions: unknown;
  allowFixtures?: boolean;
}): void {
  const catalog = upgradeRecipeCatalogSchema.parse(options.catalog);
  const evidence = upgradeQualificationEvidenceSchema.parse(options.evidence);
  const dispositions = upgradeMigrationDispositionsSchema.parse(options.dispositions);
  if (evidence.purpose === "fixture" && !options.allowFixtures) {
    throw new Error("Fixture evidence cannot qualify a production release.");
  }
  validateUpgradeRecipeCatalogReferences(catalog);
  const artifacts = new Map(catalog.artifacts.map((artifact) => [artifact.id, artifact]));
  const qualifications = new Map(
    catalog.qualifications.map((qualification) => [qualification.id, qualification]),
  );
  // Selectors advertise the complete Cartesian installation-class support surface.
  for (const recipe of catalog.recipes) {
    if (recipe.purpose === "production") {
      for (const releaseId of [...recipe.source.releaseIds, ...recipe.targetReleaseIds]) {
        const release = catalog.releases.find((item) => item.id === releaseId);
        if (
          !release?.installationManifestArtifactId ||
          !artifacts.has(release.installationManifestArtifactId)
        ) {
          throw new Error(
            "Production routes require authenticated installed-file manifests for source and target.",
          );
        }
      }
    }
    for (const sourceId of recipe.source.releaseIds) {
      for (const targetId of recipe.targetReleaseIds) {
        for (const installKind of recipe.source.installKinds) {
          for (const platform of recipe.source.platforms) {
            for (const stateContractClass of recipe.source.stateContractClasses) {
              const source = catalog.releases.find((item) => item.id === sourceId);
              if (
                !source ||
                !catalog.qualifications.some(
                  (item) =>
                    recipe.qualificationIds.includes(item.id) &&
                    item.recipe.id === recipe.id &&
                    item.recipe.revision === recipe.revision &&
                    item.sourceReleaseId === sourceId &&
                    item.targetReleaseId === targetId &&
                    item.installKind === installKind &&
                    item.runtimeFamily === source.runtimeFamily &&
                    item.stateContractClass === stateContractClass &&
                    item.platform.os === platform.os &&
                    item.platform.arch === platform.arch &&
                    item.platform.serviceMode === platform.serviceMode,
                )
              ) {
                throw new Error("Advertised recipe selector lacks exact qualification coverage.");
              }
            }
          }
        }
      }
    }
  }
  const seen = new Set<string>();
  function requireBinding(actual: z.infer<typeof binding>, expectedId?: string) {
    const expected = artifacts.get(actual.id);
    if (
      !expected ||
      (expectedId && actual.id !== expectedId) ||
      actual.sha256 !== expected.sha256 ||
      actual.length !== expected.length
    ) {
      throw new Error(`Artifact binding mismatch: ${actual.id}`);
    }
  }
  function requireCases(results: z.infer<typeof result>[], required: readonly string[]) {
    const names = new Set(results.map((item) => item.name));
    if (
      names.size !== results.length ||
      results.some((item) => !item.passed) ||
      required.some((name) => !names.has(name))
    ) {
      throw new Error("Missing, duplicate, or failed mandatory qualification evidence.");
    }
    for (const item of results) {
      if (!artifacts.has(item.diagnosticsArtifactId)) {
        throw new Error(`Missing diagnostics artifact: ${item.diagnosticsArtifactId}`);
      }
    }
  }
  for (const route of evidence.routes) {
    if (seen.has(route.qualificationId)) {
      throw new Error("Duplicate route evidence.");
    }
    seen.add(route.qualificationId);
    const qualification = qualifications.get(route.qualificationId);
    const recipe = catalog.recipes.find(
      (item) =>
        item.id === qualification?.recipe.id && item.revision === qualification.recipe.revision,
    );
    if (!qualification || !recipe || !recipe.qualificationIds.includes(qualification.id)) {
      throw new Error("Evidence refers to an unknown recipe revision or qualification.");
    }
    if (recipe.purpose === "fixture" && !options.allowFixtures) {
      throw new Error("Fixture recipe cannot qualify a production release.");
    }
    if (route.recipeSha256 !== upgradeQualificationRecipeDigest(recipe)) {
      throw new Error("Recipe digest changed since qualification.");
    }
    const source = catalog.releases.find((item) => item.id === qualification.sourceReleaseId);
    const target = catalog.releases.find((item) => item.id === qualification.targetReleaseId);
    if (
      !source ||
      !target ||
      !recipe.source.releaseIds.includes(source.id) ||
      !recipe.targetReleaseIds.includes(target.id) ||
      !recipe.source.installKinds.includes(qualification.installKind) ||
      !recipe.source.stateContractClasses.includes(qualification.stateContractClass) ||
      source.runtimeFamily !== qualification.runtimeFamily ||
      !recipe.source.platforms.some(
        (platform) =>
          platform.os === qualification.platform.os &&
          platform.arch === qualification.platform.arch &&
          platform.serviceMode === qualification.platform.serviceMode,
      )
    ) {
      throw new Error("Qualification installation class is outside its recipe selectors.");
    }
    if (
      findQualifiedUpgradeRecipes(catalog, target.id, {
        ...qualification,
        releaseId: source.id,
        identityClass: "verified-release",
      }).length > 1
    ) {
      throw new Error("Catalog graph, references, or route selectors are inconsistent.");
    }
    requireBinding(route.sourceArtifact, source.artifactId);
    requireBinding(route.targetArtifact, target.artifactId);
    if (recipe.purpose === "production" && !qualification.executor) {
      throw new Error("Production qualification requires an exact executor binding.");
    }
    requireBinding(route.runnerArtifact, qualification.executor?.runnerManifestArtifactId);
    requireBinding(route.runtimeArtifact, qualification.executor?.runtimeArtifactId);
    requireBinding(route.bootstrapArtifact, qualification.executor?.bootstrapArtifactId);
    for (const item of [route.fixtureArtifact, ...route.adapterArtifacts]) {
      requireBinding(item);
    }
    for (const step of recipe.steps) {
      const adapter = catalog.adapters.find(
        (item) =>
          item.id === step.adapter.id &&
          item.revision === step.adapter.revision &&
          item.bundleArtifactId === step.adapter.bundleArtifactId &&
          item.parameterContractId === step.adapter.parameterContractId,
      );
      if (
        !adapter ||
        !adapter.phases.includes(step.phase) ||
        Object.keys(step.parameters).length !== 0
      ) {
        throw new Error("Unknown adapter revision, phase, or parameter contract.");
      }
    }
    const adapterIds = new Set(route.adapterArtifacts.map((item) => item.id));
    if (
      adapterIds.size !== route.adapterArtifacts.length ||
      recipe.steps.some((step) => !adapterIds.has(step.adapter.bundleArtifactId))
    ) {
      throw new Error("Missing or duplicate adapter artifact evidence.");
    }
    requireCases(route.cases, mandatoryUpgradeQualificationCases);
    requireCases(route.crashBoundaries, mandatoryUpgradeCrashBoundaries);
  }
  for (const qualification of catalog.qualifications) {
    if (!seen.has(qualification.id)) {
      throw new Error(`Missing advertised route evidence: ${qualification.id}`);
    }
  }
  const contracts = new Set(options.changedContracts);
  if (
    contracts.size !== options.changedContracts.length ||
    new Set(dispositions.map((item) => item.contractId)).size !== dispositions.length
  ) {
    throw new Error("Duplicate contract disposition.");
  }
  for (const contract of contracts) {
    const disposition = dispositions.find((item) => item.contractId === contract);
    if (
      !disposition ||
      (disposition.disposition === "migration" && disposition.qualificationIds.length === 0) ||
      disposition.qualificationIds.some((id) => !seen.has(id))
    ) {
      throw new Error(`Missing migration disposition or coverage: ${contract}`);
    }
  }
}
