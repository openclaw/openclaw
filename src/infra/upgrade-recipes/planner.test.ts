import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { inspectUpgradeRecipeInstallation, type UpgradeRecipeInventory } from "./inventory.js";
import { createUpgradeRecipePlan } from "./planner.js";
import { upgradeRecipeCatalogSchema, type UpgradeRecipeCatalog } from "./schema.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const platform = { os: "linux", arch: "x64", serviceMode: "systemd" } as const;

// Synthetic metadata exercises selection only; these are not qualified release artifacts.
function fixture() {
  const inventory: UpgradeRecipeInventory = {
    root: "/fixture/installation",
    serviceRoot: "/fixture/installation",
    observedVersion: "2026.9.1",
    identityClass: "verified-release",
    releaseId: "source",
    installKind: "npm",
    platform,
    runtimeFamily: "node",
    stateContractClass: "legacy",
    recovery: "clear",
    issues: [],
  };
  const catalog: UpgradeRecipeCatalog = {
    schemaVersion: 1,
    id: "synthetic",
    artifacts: ["source", "target", "adapter", "evidence"].map((id) => ({
      id,
      sha256: "a".repeat(64),
      length: 100,
    })),
    releases: ["source", "target"].map((id) => ({
      id,
      version: id === "source" ? "2026.9.1" : "2026.10.1",
      buildId: id,
      commit: "b".repeat(40),
      artifactId: id,
      runtimeFamily: "node",
      stateContracts: { state: 1, agent: 1 },
    })),
    recipes: [
      {
        schemaVersion: 1,
        purpose: "production",
        id: "direct",
        revision: 1,
        summary: "Synthetic direct transition",
        catalogId: "synthetic",
        source: {
          releaseIds: ["source"],
          identityClasses: ["verified-release"],
          stateContractClasses: ["legacy"],
          installKinds: ["npm"],
          platforms: [platform],
        },
        targetReleaseIds: ["target"],
        executor: { protocol: 1, requiredCapabilities: ["maintenance"] },
        steps: [
          {
            id: "migrate",
            adapter: {
              id: "synthetic-adapter",
              revision: 1,
              bundleArtifactId: "adapter",
              parameterContractId: "empty",
            },
            phase: "quiesced-migrate",
            requires: [],
            resources: [{ kind: "configuration", scope: "active-profile", access: "write" }],
            parameters: {},
            mutation: "live-state",
            postconditionContractIds: ["preserve-policy"],
            recovery: {
              mode: "transactional-reconcile",
              contractId: "reconcile",
              snapshotRequired: true,
            },
          },
        ],
        safety: {
          requiresQuiescence: true,
          requiresMaintenanceGate: true,
          policyContractIds: ["preserve-policy"],
          rollbackContractId: "rollback",
          unattendedEligible: false,
        },
        qualificationIds: ["qualified"],
      },
    ],
    adapters: [
      {
        id: "synthetic-adapter",
        revision: 1,
        bundleArtifactId: "adapter",
        parameterContractId: "empty",
        phases: ["quiesced-migrate"],
        parameterContract: "empty-object",
        inputStateContractClasses: ["legacy"],
        outputStateContractClass: "current",
      },
    ],
    qualifications: [
      {
        id: "qualified",
        recipe: { id: "direct", revision: 1 },
        sourceReleaseId: "source",
        targetReleaseId: "target",
        installKind: "npm",
        platform,
        runtimeFamily: "node",
        stateContractClass: "legacy",
        evidenceArtifactId: "evidence",
      },
    ],
  };
  const [recipe] = catalog.recipes;
  const [qualification] = catalog.qualifications;
  const [adapter] = catalog.adapters;
  const [artifact] = catalog.artifacts;
  const step = recipe?.steps[0];
  if (!recipe || !qualification || !adapter || !artifact || !step) {
    throw new Error(
      "Synthetic fixture must contain its recipe, qualification, adapter, artifact, and step.",
    );
  }
  return {
    inventory,
    catalog,
    recipe,
    qualification,
    adapter,
    artifact,
    step,
    targetReleaseId: "target",
  };
}

const codes = (options: Parameters<typeof createUpgradeRecipePlan>[0]) =>
  createUpgradeRecipePlan(options).blockers.map((blocker) => blocker.code);

describe("upgrade recipe planning", () => {
  it("selects an exact qualified direct route but never grants execution authority", () => {
    const plan = createUpgradeRecipePlan(fixture());
    expect(plan.recipeRefs).toEqual([{ id: "direct", revision: 1 }]);
    expect(plan.steps.map((step) => [step.id, step.inspection])).toEqual([["migrate", "unknown"]]);
    expect(plan).toMatchObject({ kind: "report-only", mutationEnabled: false, outcome: "blocked" });
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "recipe-execution-disabled",
      "catalog-authentication-unavailable",
      "adapter-inspection-unverified",
    ]);
  });

  it.each(["platform", "owner", "runtime", "state", "source", "target"])(
    "does not reuse qualification for a different %s",
    (field) => {
      const options = fixture();
      const qualification = options.qualification;
      switch (field) {
        case "platform":
          qualification.platform = { ...platform, arch: "arm64" };
          break;
        case "owner":
          qualification.installKind = "pnpm";
          break;
        case "runtime":
          qualification.runtimeFamily = "bun";
          break;
        case "state":
          qualification.stateContractClass = "other";
          break;
        case "source":
          qualification.sourceReleaseId = "target";
          break;
        case "target":
          qualification.targetReleaseId = "source";
          break;
      }
      const plan = createUpgradeRecipePlan(options);
      expect(plan.recipeRefs).toEqual([]);
      expect(plan.blockers.map((blocker) => blocker.code)).toContain("route-unqualified");
    },
  );

  it("refuses ambiguous immutable recipe revisions rather than picking the newest", () => {
    const options = fixture();
    options.catalog.recipes.push({
      ...options.recipe,
      revision: 2,
      qualificationIds: ["qualified-two"],
    });
    options.catalog.qualifications.push({
      ...options.qualification,
      id: "qualified-two",
      recipe: { id: "direct", revision: 2 },
    });
    expect(codes(options)).toContain("route-ambiguous");
  });

  it("keeps unknown provenance, live state and recovery ownership visible", () => {
    const options = fixture();
    options.inventory.identityClass = "unknown";
    options.inventory.stateContractClass = undefined;
    options.inventory.recovery = "active";
    options.inventory.serviceRoot = "/fixture/other";
    const plan = createUpgradeRecipePlan(options);
    expect(plan.steps).toEqual([]);
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "source-identity-unverified",
        "state-contract-unverified",
        "active-recovery-owner",
        "installation-roots-differ",
      ]),
    );
  });

  it.each(["duplicate", "missing-artifact", "missing-dependency", "cycle", "phase", "conflict"])(
    "rejects a %s in the declarative graph",
    (failure) => {
      const options = fixture();
      const recipe = options.recipe;
      const first = options.step;
      switch (failure) {
        case "duplicate":
          recipe.steps.push(first);
          break;
        case "missing-artifact":
          options.catalog.artifacts.pop();
          break;
        case "missing-dependency":
          first.requires = ["absent"];
          break;
        case "cycle":
          first.requires = [first.id];
          break;
        case "phase":
          first.phase = "prepare";
          break;
        case "conflict":
          recipe.steps.push({ ...first, id: "other" });
          break;
      }
      expect(codes(options)).toContain("catalog-inconsistent");
    },
  );

  it("orders dependencies deterministically and binds changes into the report digest", () => {
    const options = fixture();
    const first = options.step;
    options.recipe.steps.push({
      ...first,
      id: "verify",
      requires: ["migrate"],
      phase: "verify",
      mutation: "none",
      resources: [{ kind: "configuration", scope: "active-profile", access: "read" }],
    });
    options.adapter.phases.push("verify");
    const before = createUpgradeRecipePlan(options);
    options.recipe.steps.reverse();
    options.catalog.artifacts.reverse();
    options.catalog.releases.reverse();
    const reordered = createUpgradeRecipePlan(options);
    expect(reordered.steps.map((step) => step.id)).toEqual(["migrate", "verify"]);
    expect(reordered.digest).toBe(before.digest);
    options.artifact.sha256 = "c".repeat(64);
    expect(createUpgradeRecipePlan(options).digest).not.toBe(before.digest);
  });

  function serviceVerificationFixture() {
    const options = fixture();
    options.step.id = "service-ready";
    options.step.phase = "verify";
    options.step.adapter.id = "core.service-verify";
    options.step.resources = [
      { kind: "service-definition", scope: "installation", access: "write" },
    ];
    options.step.recovery = {
      mode: "transactional-reconcile",
      contractId: "core.service-verify.v1",
      snapshotRequired: false,
    };
    options.step.postconditionContractIds = ["core.managed-service-ready.v1"];
    options.adapter.id = "core.service-verify";
    options.adapter.phases = ["verify"];
    return options;
  }

  it("admits only the exact native service verification lifecycle declaration without granting execution", () => {
    const options = serviceVerificationFixture();
    const plan = createUpgradeRecipePlan(options);
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "recipe-execution-disabled",
      "catalog-authentication-unavailable",
      "adapter-inspection-unverified",
    ]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      phase: "verify",
      mutation: "live-state",
      adapter: { id: "core.service-verify", revision: 1 },
    });
    expect(plan.mutationEnabled).toBe(false);
  });

  it.each(["state-db", "configuration", "package"] as const)(
    "refuses verify-phase %s writes even under the native service adapter name",
    (kind) => {
      const options = serviceVerificationFixture();
      options.step.resources = [{ kind, scope: "installation", access: "write" }];
      expect(codes(options)).toContain("catalog-inconsistent");
    },
  );

  it("preserves the case-sensitive published build identity without widening catalog IDs", () => {
    const { catalog } = fixture();
    const buildId = "2026.9.1-release-ad6fe23aecb9-2026-09-03T15-04-19.382Z";
    catalog.releases[0]!.buildId = buildId;
    expect(upgradeRecipeCatalogSchema.parse(catalog).releases[0]!.buildId).toBe(buildId);
    catalog.releases[0]!.id = "Source";
    expect(upgradeRecipeCatalogSchema.safeParse(catalog).success).toBe(false);
  });

  it.each([
    "generic-adapter",
    "adapter-revision",
    "wrong-recovery",
    "snapshot-rewind",
    "mixed-resources",
    "wrong-scope",
    "parameters",
    "wrong-postcondition",
  ] as const)("refuses service verification with %s", (defect) => {
    const options = serviceVerificationFixture();
    switch (defect) {
      case "generic-adapter":
        options.step.adapter.id = "arbitrary-service-writer";
        options.adapter.id = "arbitrary-service-writer";
        break;
      case "adapter-revision":
        options.step.adapter.revision = 2;
        options.adapter.revision = 2;
        break;
      case "wrong-recovery":
        options.step.recovery.contractId = "generic-reconcile";
        break;
      case "snapshot-rewind":
        options.step.recovery.snapshotRequired = true;
        break;
      case "mixed-resources":
        options.step.resources.push({
          kind: "configuration",
          scope: "active-profile",
          access: "write",
        });
        break;
      case "wrong-scope":
        options.step.resources[0]!.scope = "active-profile";
        break;
      case "parameters":
        options.step.parameters = { command: "unreviewed" };
        break;
      case "wrong-postcondition":
        options.step.postconditionContractIds = ["generic-ready"];
        break;
    }
    expect(codes(options)).toContain("catalog-inconsistent");
  });

  it("does not infer migration completion from a release version", () => {
    const options = fixture();
    const plan = createUpgradeRecipePlan({
      ...options,
      probes: {
        migrate: { status: "already-satisfied", verified: false, evidenceDigest: "a".repeat(64) },
      },
    });
    expect(plan.steps.map((step) => step.inspection)).toEqual(["already-satisfied"]);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("adapter-inspection-unverified");
  });

  it("verifies completed transformations against their output contract, not their former input", () => {
    const options = fixture();
    options.inventory.stateContractClass = "current";
    options.recipe.source.stateContractClasses.push("current");
    options.qualification.stateContractClass = "current";
    const plan = createUpgradeRecipePlan({
      ...options,
      probes: {
        migrate: { status: "already-satisfied", verified: true, evidenceDigest: "a".repeat(64) },
      },
    });
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain(
      "adapter-contract-incompatible",
    );
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain(
      "adapter-inspection-unverified",
    );
    expect(plan.mutationEnabled).toBe(false);
  });

  it.each(["fixture", "parameters", "adapter", "stale-version"])(
    "refuses unsupported or stale %s inputs",
    (failure) => {
      const options = fixture();
      switch (failure) {
        case "fixture":
          options.recipe.purpose = "fixture";
          break;
        case "parameters":
          options.step.parameters = { command: "do-not-execute" };
          break;
        case "adapter":
          options.step.adapter.revision = 2;
          break;
        case "stale-version":
          options.inventory.observedVersion = "2026.9.2";
          break;
      }
      expect(codes(options)).toContain(
        failure === "fixture"
          ? "route-unqualified"
          : failure === "stale-version"
            ? "source-preconditions-changed"
            : "adapter-unsupported",
      );
    },
  );
});

describe("passive inventory and strict envelopes", () => {
  it("observes source metadata without executing package hooks or claiming live state/ownership", async () => {
    const root = dirs.make("openclaw-recipe-inventory-");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        packageManager: "npm@12",
        openclaw: { schemaVersions: { state: 8, agent: 4 } },
        scripts: { postinstall: "must-not-run" },
      }),
    );
    await fs.writeFile(path.join(root, ".git"), "gitdir: /fixture/worktree");
    const inventory = await inspectUpgradeRecipeInstallation(root);
    expect(inventory).toMatchObject({
      observedVersion: "2026.9.1",
      declaredStateContracts: { state: 8, agent: 4 },
      identityClass: "unknown",
      installKind: "git",
      recovery: "unknown",
      platform: { serviceMode: "unknown" },
    });
    expect(inventory.stateContractClass).toBeUndefined();
    expect(
      createUpgradeRecipePlan({ inventory }).blockers.map((blocker) => blocker.code),
    ).toContain("catalog-unavailable");
    expect(await fs.readdir(root)).toEqual([".git", "package.json"]);
  });

  it.each([
    "command",
    "revision",
    "phase",
    "quiescence",
    "gate",
    "unknown-source",
    "empty-steps",
    "unknown-adapter",
    "snapshot",
    "schema-version",
  ])("rejects malformed %s envelope fields", (failure) => {
    const { recipe, step } = fixture();
    const variants: Record<string, unknown> = {
      command: { ...recipe, command: "arbitrary shell" },
      revision: { ...recipe, revision: 0 },
      phase: { ...recipe, steps: [{ ...step, phase: "shutdown" }] },
      quiescence: { ...recipe, safety: { ...recipe.safety, requiresQuiescence: false } },
      gate: { ...recipe, safety: { ...recipe.safety, requiresMaintenanceGate: false } },
      "unknown-source": { ...recipe, source: { ...recipe.source, identityClasses: ["unknown"] } },
      "empty-steps": { ...recipe, steps: [] },
      "unknown-adapter": {
        ...recipe,
        steps: [
          {
            ...step,
            adapter: { ...step.adapter, command: "arbitrary shell" },
          },
        ],
      },
      snapshot: {
        ...recipe,
        steps: [
          {
            ...step,
            recovery: { ...step.recovery, snapshotRequired: "yes" },
          },
        ],
      },
      "schema-version": { ...recipe, schemaVersion: 2 },
    };
    expect(
      upgradeRecipeCatalogSchema.safeParse({
        ...fixture().catalog,
        recipes: [variants[failure]],
      }).success,
    ).toBe(false);
  });
});
