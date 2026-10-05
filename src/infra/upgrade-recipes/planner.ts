import { createHash } from "node:crypto";
import type { UpgradeRecipeInventory } from "./inventory.js";
import {
  upgradeRecipeCatalogSchema,
  type UpgradeRecipe,
  type UpgradeRecipeCatalog,
  type UpgradeRecipeStep,
} from "./schema.js";

type Blocker = { code: string; message: string; nextAction: string };
type Probe = {
  status: "needed" | "already-satisfied" | "not-applicable" | "blocked";
  verified: boolean;
  evidenceDigest: string;
};
export type UpgradeRecipePlan = {
  schemaVersion: 1;
  kind: "report-only";
  mutationEnabled: false;
  outcome: "blocked";
  inventory: UpgradeRecipeInventory;
  targetReleaseId?: string;
  catalogDigest?: string;
  recipeRefs: Array<{ id: string; revision: number }>;
  steps: Array<
    UpgradeRecipeStep & { inspection: "unknown" | Probe["status"]; evidenceDigest?: string }
  >;
  blockers: Blocker[];
  verificationGaps: string[];
  digest: string;
};

const phaseOrder = { prepare: 0, "quiesced-migrate": 1, "postpublish-maintenance": 2, verify: 3 };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortedById<T extends { id: string; revision?: number }>(values: T[]): T[] {
  return values.toSorted((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : (a.revision ?? 0) - (b.revision ?? 0),
  );
}

function catalogDigest(catalog: UpgradeRecipeCatalog): string {
  // Normalize a private copy: neither planning nor hashing changes admitted metadata.
  const normalized = structuredClone(catalog);
  normalized.artifacts = sortedById(normalized.artifacts);
  normalized.releases = sortedById(normalized.releases);
  normalized.adapters = sortedById(normalized.adapters);
  normalized.qualifications = sortedById(normalized.qualifications);
  normalized.recipes = sortedById(normalized.recipes);
  const compareCanonical = (a: unknown, b: unknown) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  for (const adapter of normalized.adapters) {
    adapter.phases = adapter.phases.toSorted();
    adapter.inputStateContractClasses = adapter.inputStateContractClasses.toSorted();
  }
  for (const recipe of normalized.recipes) {
    recipe.source.releaseIds = recipe.source.releaseIds.toSorted();
    recipe.source.identityClasses = recipe.source.identityClasses.toSorted();
    recipe.source.stateContractClasses = recipe.source.stateContractClasses.toSorted();
    recipe.source.installKinds = recipe.source.installKinds.toSorted();
    recipe.source.platforms = recipe.source.platforms.toSorted(compareCanonical);
    recipe.targetReleaseIds = recipe.targetReleaseIds.toSorted();
    recipe.qualificationIds = recipe.qualificationIds.toSorted();
    recipe.executor.requiredCapabilities = recipe.executor.requiredCapabilities.toSorted();
    recipe.safety.policyContractIds = recipe.safety.policyContractIds.toSorted();
    if (recipe.supersedes) {
      recipe.supersedes = sortedById(recipe.supersedes);
    }
    recipe.steps = sortedById(recipe.steps);
    for (const step of recipe.steps) {
      step.requires = step.requires.toSorted();
      step.resources = step.resources.toSorted(compareCanonical);
      step.postconditionContractIds = step.postconditionContractIds.toSorted();
    }
  }
  return digest(normalized);
}

function matchesPlatform(
  a: UpgradeRecipeInventory["platform"],
  b: UpgradeRecipeInventory["platform"],
): boolean {
  return a.os === b.os && a.arch === b.arch && a.serviceMode === b.serviceMode;
}

/** Only the fixed native service reconciler may activate a service while verifying readiness.
 * This structural allowance is not execution authority; execution still checks the exact reviewed adapter.
 */
function isEngineServiceVerification(step: UpgradeRecipeStep): boolean {
  return (
    step.phase === "verify" &&
    step.mutation === "live-state" &&
    step.adapter.id === "core.service-verify" &&
    step.adapter.revision === 1 &&
    Object.keys(step.parameters).length === 0 &&
    step.resources.length === 1 &&
    step.resources.every(
      (resource) =>
        resource.kind === "service-definition" &&
        resource.scope === "installation" &&
        resource.access === "write",
    ) &&
    step.recovery.mode === "transactional-reconcile" &&
    step.recovery.contractId === "core.service-verify.v1" &&
    !step.recovery.snapshotRequired &&
    step.postconditionContractIds.length === 1 &&
    step.postconditionContractIds[0] === "core.managed-service-ready.v1"
  );
}

/** Stable topological ordering within engine-owned phases; recipes cannot move the lifecycle. */
function orderSteps(recipe: UpgradeRecipe): UpgradeRecipeStep[] {
  const byId = new Map(recipe.steps.map((step) => [step.id, step]));
  if (byId.size !== recipe.steps.length) {
    throw new Error("Duplicate step identities.");
  }
  for (const step of recipe.steps) {
    for (const required of step.requires) {
      const dependency = byId.get(required);
      if (!dependency || phaseOrder[dependency.phase] > phaseOrder[step.phase]) {
        throw new Error("Missing prerequisite or prerequisite in a later engine phase.");
      }
    }
    if (
      (step.mutation === "live-state" && step.phase === "prepare") ||
      (step.phase === "verify" && step.mutation !== "none" && !isEngineServiceVerification(step)) ||
      (step.mutation === "none" && step.resources.some((resource) => resource.access === "write"))
    ) {
      throw new Error("Mutation is incompatible with its engine phase or resource declaration.");
    }
  }
  const ordered: UpgradeRecipeStep[] = [];
  const remaining = new Set(byId.keys());
  for (const phase of Object.keys(phaseOrder)) {
    while ([...remaining].some((id) => byId.get(id)?.phase === phase)) {
      const next = sortedById(recipe.steps).find(
        (step) =>
          remaining.has(step.id) &&
          step.phase === phase &&
          step.requires.every((id) => !remaining.has(id)),
      );
      if (!next) {
        throw new Error("Cyclic step dependencies.");
      }
      ordered.push(next);
      remaining.delete(next.id);
    }
  }
  const ancestors = new Map<string, Set<string>>();
  for (const step of ordered) {
    ancestors.set(
      step.id,
      new Set(step.requires.flatMap((id) => [id, ...(ancestors.get(id) ?? [])])),
    );
    for (const prior of ordered.slice(0, ordered.indexOf(step))) {
      const overlaps = prior.resources.some((a) =>
        step.resources.some(
          (b) =>
            a.kind === b.kind &&
            (a.scope === b.scope || (a.scope !== "installation" && b.scope !== "installation")) &&
            (a.access === "write" || b.access === "write"),
        ),
      );
      if (overlaps && prior.phase === step.phase && !ancestors.get(step.id)?.has(prior.id)) {
        throw new Error("Overlapping resources require an explicit dependency.");
      }
    }
  }
  return ordered;
}

export function validateUpgradeRecipeCatalogReferences(catalog: UpgradeRecipeCatalog): void {
  for (const collection of [catalog.artifacts, catalog.releases, catalog.qualifications]) {
    if (new Set(collection.map((entry) => entry.id)).size !== collection.length) {
      throw new Error("Duplicate catalog identities.");
    }
  }
  for (const collection of [catalog.recipes, catalog.adapters]) {
    if (
      new Set(collection.map((entry) => `${entry.id}@${entry.revision}`)).size !== collection.length
    ) {
      throw new Error("Duplicate revision identities.");
    }
  }
  const artifacts = new Set(catalog.artifacts.map((entry) => entry.id));
  const releases = new Set(catalog.releases.map((entry) => entry.id));
  if (
    catalog.releases.some(
      (release) =>
        !artifacts.has(release.artifactId) ||
        (release.installationManifestArtifactId !== undefined &&
          !artifacts.has(release.installationManifestArtifactId)),
    ) ||
    catalog.adapters.some((adapter) => !artifacts.has(adapter.bundleArtifactId)) ||
    catalog.qualifications.some(
      (qualification) =>
        !artifacts.has(qualification.evidenceArtifactId) ||
        (qualification.executor !== undefined &&
          Object.values(qualification.executor).some((id) => !artifacts.has(id))) ||
        !releases.has(qualification.sourceReleaseId) ||
        !releases.has(qualification.targetReleaseId) ||
        !catalog.recipes.some(
          (recipe) =>
            recipe.id === qualification.recipe.id &&
            recipe.revision === qualification.recipe.revision,
        ),
    )
  ) {
    throw new Error("Catalog artifact, release, or qualification reference is missing.");
  }
  for (const recipe of catalog.recipes) {
    if (
      recipe.catalogId !== catalog.id ||
      [...recipe.source.releaseIds, ...recipe.targetReleaseIds].some((id) => !releases.has(id)) ||
      recipe.qualificationIds.some(
        (id) =>
          !catalog.qualifications.some(
            (qualification) =>
              qualification.id === id &&
              qualification.recipe.id === recipe.id &&
              qualification.recipe.revision === recipe.revision,
          ),
      )
    ) {
      throw new Error(
        "Recipe is bound to the wrong catalog or has missing release/qualification references.",
      );
    }
    orderSteps(recipe);
  }
}

/** Select declarative routes only; matching metadata never grants execution authority. */
export function findQualifiedUpgradeRecipes(
  catalog: UpgradeRecipeCatalog,
  targetReleaseId: string,
  inventory: Pick<
    UpgradeRecipeInventory,
    | "releaseId"
    | "identityClass"
    | "installKind"
    | "stateContractClass"
    | "platform"
    | "runtimeFamily"
  >,
): UpgradeRecipe[] {
  return catalog.recipes.filter(
    (recipe) =>
      recipe.purpose === "production" &&
      recipe.source.releaseIds.includes(inventory.releaseId ?? "") &&
      recipe.targetReleaseIds.includes(targetReleaseId) &&
      recipe.source.identityClasses.some((identity) => identity === inventory.identityClass) &&
      recipe.source.installKinds.some((kind) => kind === inventory.installKind) &&
      recipe.source.stateContractClasses.includes(inventory.stateContractClass ?? "") &&
      recipe.source.platforms.some((platform) => matchesPlatform(platform, inventory.platform)) &&
      recipe.qualificationIds.some((id) =>
        catalog.qualifications.some(
          (qualification) =>
            qualification.id === id &&
            qualification.sourceReleaseId === inventory.releaseId &&
            qualification.targetReleaseId === targetReleaseId &&
            qualification.installKind === inventory.installKind &&
            matchesPlatform(qualification.platform, inventory.platform) &&
            qualification.runtimeFamily === inventory.runtimeFamily &&
            qualification.stateContractClass === inventory.stateContractClass,
        ),
      ),
  );
}

/** Pure passive planning. Catalog bytes and probe observations are never authorization. */
export function createUpgradeRecipePlan(options: {
  inventory: UpgradeRecipeInventory;
  targetReleaseId?: string;
  catalog?: unknown;
  probes?: Record<string, Probe>;
}): UpgradeRecipePlan {
  const { inventory, targetReleaseId } = options;
  const plan: UpgradeRecipePlan = {
    schemaVersion: 1,
    kind: "report-only",
    mutationEnabled: false,
    outcome: "blocked",
    inventory,
    targetReleaseId,
    recipeRefs: [],
    steps: [],
    blockers: [],
    verificationGaps: [
      "This passive report does not admit a runner or authorize execution.",
      "No private rehearsal, disk-capacity guarantee, snapshot, or rollback verification was performed.",
    ],
    digest: "",
  };
  const block = (code: string, message: string, nextAction: string) =>
    plan.blockers.push({ code, message, nextAction });
  const finish = () => {
    const { digest: _digest, ...content } = plan;
    plan.digest = digest(content);
    return plan;
  };
  block(
    "recipe-execution-disabled",
    "This is a report, not an executable or approved upgrade plan.",
    "Use the existing openclaw update workflow; do not treat this report as permission to migrate.",
  );
  if (inventory.identityClass === "unknown" || !inventory.releaseId) {
    block(
      "source-identity-unverified",
      "A package version is an observation, not verified artifact provenance.",
      "Establish the exact source artifact and local modifications before qualifying a route.",
    );
  }
  if (
    inventory.installKind === "unknown" ||
    inventory.platform.serviceMode === "unknown" ||
    !inventory.serviceRoot
  ) {
    block(
      "installation-owner-unverified",
      "Installation and serving Gateway ownership have not been established.",
      "Inspect the installation owner and exact service root separately from the invoking CLI.",
    );
  } else if (inventory.serviceRoot !== inventory.root) {
    block(
      "installation-roots-differ",
      "The invoking CLI and serving Gateway have different installation roots.",
      "Inspect and plan for the serving installation explicitly; do not publish into the CLI root.",
    );
  }
  if (inventory.recovery !== "clear") {
    block(
      inventory.recovery === "active" ? "active-recovery-owner" : "recovery-status-unverified",
      "Recovery ownership is active or has not been inspected.",
      "Keep unresolved operations with their existing recovery owner; inspect without reconciliation.",
    );
  }
  if (!inventory.stateContractClass) {
    block(
      "state-contract-unverified",
      "Live state contracts have not been inspected; package declarations cannot substitute.",
      "Inspect actual participating state through its read-only storage owner.",
    );
  }
  if (options.catalog === undefined) {
    block(
      "catalog-unavailable",
      "No release-qualified recipe catalog is installed.",
      "Supply a local catalog with --catalog for an untrusted, report-only preview.",
    );
    return finish();
  }
  const parsed = upgradeRecipeCatalogSchema.safeParse(options.catalog);
  if (!parsed.success) {
    block(
      "catalog-invalid",
      "Catalog does not satisfy the strict versioned recipe contracts.",
      "Correct the catalog envelope; unknown fields and arbitrary command fields are rejected.",
    );
    return finish();
  }
  const catalog = parsed.data;
  try {
    validateUpgradeRecipeCatalogReferences(catalog);
  } catch {
    block(
      "catalog-inconsistent",
      "Catalog identities, dependency graph, resource declarations, or artifact closure are inconsistent.",
      "Correct duplicate/missing references, cycles, phase inversions, or conflicting resources.",
    );
    return finish();
  }
  plan.catalogDigest = catalogDigest(catalog);
  block(
    "catalog-authentication-unavailable",
    "Local catalog metadata and qualification claims have not been authenticated.",
    "Use authenticated executable planning before approving any migration.",
  );
  const target = catalog.releases.find((release) => release.id === targetReleaseId);
  if (!target) {
    block(
      "target-identity-unresolved",
      "Select one exact catalog release ID; latest/stable are not artifact identities.",
      "Pass --target with an exact release ID from this catalog.",
    );
    return finish();
  }
  const source = catalog.releases.find((release) => release.id === inventory.releaseId);
  if (!source) {
    block(
      "source-record-missing",
      "The observed source identity is absent from this catalog.",
      "Supply the exact source release record; do not match only its version string.",
    );
    return finish();
  }
  if (inventory.identityClass === "unknown" || !inventory.stateContractClass) {
    return finish();
  }
  if (
    inventory.observedVersion !== source.version ||
    source.runtimeFamily !== inventory.runtimeFamily
  ) {
    block(
      "source-preconditions-changed",
      "Observed source version or runtime does not match the selected source record.",
      "Reinspect source facts and regenerate the report.",
    );
    return finish();
  }
  const matches = findQualifiedUpgradeRecipes(catalog, target.id, inventory);
  const recipe = matches[0];
  if (matches.length !== 1 || !recipe) {
    block(
      matches.length === 0 ? "route-unqualified" : "route-ambiguous",
      "No unique qualified direct route matches the complete installation class.",
      "Publish exact qualification for this installation class; bridge routes are not implemented.",
    );
    return finish();
  }
  plan.recipeRefs = [{ id: recipe.id, revision: recipe.revision }];
  let stateContractClass = inventory.stateContractClass;
  for (const step of orderSteps(recipe)) {
    const adapter = catalog.adapters.find(
      (candidate) =>
        candidate.id === step.adapter.id &&
        candidate.revision === step.adapter.revision &&
        candidate.bundleArtifactId === step.adapter.bundleArtifactId &&
        candidate.parameterContractId === step.adapter.parameterContractId,
    );
    const probe = options.probes?.[step.id];
    plan.steps.push({
      ...step,
      inspection: probe?.status ?? "unknown",
      ...(probe ? { evidenceDigest: probe.evidenceDigest } : {}),
    });
    if (
      !adapter ||
      !adapter.phases.includes(step.phase) ||
      Object.keys(step.parameters).length > 0
    ) {
      block(
        "adapter-unsupported",
        "Adapter identity, phase, or parameter contract is not supported.",
        "Bind the exact reviewed adapter and supported parameter contract; never run catalog code directly.",
      );
      continue;
    }
    if (
      probe?.status === "already-satisfied" && probe.verified
        ? adapter.outputStateContractClass !== stateContractClass
        : probe?.status !== "not-applicable" &&
          !adapter.inputStateContractClasses.includes(stateContractClass)
    ) {
      block(
        "adapter-contract-incompatible",
        "An adapter cannot consume the preceding actual state contract.",
        "Correct adapter input/output contracts and route qualification.",
      );
    }
    if (
      !probe ||
      !probe.verified ||
      !/^[a-f0-9]{64}$/.test(probe.evidenceDigest) ||
      probe.status === "blocked"
    ) {
      block(
        "adapter-inspection-unverified",
        "Actual adapter preconditions or postconditions have not been verified.",
        "Inspect actual state without loading user code; do not infer completed migrations from source versions.",
      );
    } else if (probe.status !== "not-applicable") {
      stateContractClass = adapter.outputStateContractClass;
    }
  }
  return finish();
}
