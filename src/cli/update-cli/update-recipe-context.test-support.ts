import { createHash } from "node:crypto";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import {
  recipeUpdateApprovalFacts,
  recipeUpdateContextSchema,
  UPDATE_RECIPE_UPDATE_CAPABILITY,
} from "./update-recipe-context.js";

const sha = "1".repeat(64);
export function approvedContext() {
  const context = recipeUpdateContextSchema.parse({
    capability: UPDATE_RECIPE_UPDATE_CAPABILITY,
    approvedPlanDigest: sha,
    approvedPlan: {},
    runner: {
      root: "/runner",
      manifestArtifactId: "runner-manifest",
      manifestDigest: sha,
      closureDigest: sha,
    },
    catalogDigest: sha,
    catalog: {
      controlRoot: "/control",
      metadataDir: "/control/metadata",
      metadataBaseUrl: "https://metadata.invalid",
      targetBaseUrl: "https://targets.invalid",
      targetPath: "catalog",
      forbiddenRoots: ["/selected-install"],
    },
    sourceReleaseId: "source",
    targetReleaseId: "target",
    route: {
      recipe: { id: "qualified", revision: 1 },
      qualificationId: "qualification",
      installKind: "npm",
      stateContractClass: "state",
      platform: { os: "linux", arch: "x64", serviceMode: "systemd" },
    },
    artifactsDirectory: "/artifacts",
    localArchivePath: "/artifacts/target.tgz",
    packageOwner: {
      manager: "npm",
      command: "/selected-prefix/bin/npm",
      globalRoot: "/selected-prefix/lib/node_modules",
      packageRoot: "/selected-install",
      npmOwner: { version: "11.16.0", lifecyclePolicy: "allow-scripts-advisory" },
    },
    targetSchemaVersions: { state: 1, agent: 1 },
    sourceStateVersions: [{ path: "/selected-state/state.sqlite", userVersion: 1 }],
    service: {
      scope: "user",
      unitName: "openclaw-gateway.service",
      managerUid: 1000,
      beforeDefinitionFingerprint: sha,
    },
    planningEvidence: {
      rehearsal: {
        sourceStateVersions: [{ path: "/selected-state/state.sqlite", userVersion: 1 }],
        stateVersions: [{ path: "/selected-state/state.sqlite", userVersion: 1 }],
        candidateSchemaVersions: { state: 1, agent: 1 },
        gatewayRestartCompletion: true,
        listenerIsolation: {
          gateway: { host: "127.0.0.1", port: 18790 },
          mcpAppSandbox: "disabled",
        },
        doctorConfigWrites: false,
      },
      snapshotCapacity: {
        reason: "state-volume",
        sqliteBytes: 1,
        pluginBytes: 0,
        requiredBytes: 10,
        candidates: [
          {
            kind: "state-volume",
            directory: "/selected-state.update-captures",
            availableBytes: 1000,
          },
        ],
        selection: { kind: "state-volume", directory: "/selected-state.update-captures/private" },
      },
      executionCapacity: {
        protocol: 1,
        measurements: {
          sourceBytes: 1,
          candidateBytes: 1,
          runnerBytes: 1,
          archiveBytes: 1,
          stateBytes: 1,
        },
        demands: [
          { directory: "/", device: "1", purpose: "package-stage-publication", requiredBytes: 10 },
          {
            directory: "/artifacts",
            device: "1",
            purpose: "retained-artifacts",
            requiredBytes: 10,
          },
          {
            directory: "/selected-state.update-captures",
            device: "1",
            purpose: "state-snapshot-scratch",
            requiredBytes: 10,
          },
        ],
        filesystems: [{ device: "1", requiredBytes: 30, availableBytes: 1000 }],
      },
    },
    maintenance: {
      binding: {
        protocol: 1,
        runId: "original",
        planDigest: sha,
        targetArtifactId: "target-artifact",
        installationKey: "/selected-install",
        stateRootKey: "/selected-state",
      },
      expected: {
        version: "2026.10.3",
        buildId: "build",
        runtimeExecutable: "/runner/node",
        installationRoot: "/selected-install",
        stateRoot: "/selected-state",
        configPath: "/selected-state/config.json",
        configHash: sha,
        configSourceDigest: sha,
        profile: "default",
      },
      port: 18789,
      timeoutMs: 1000,
      stateVersions: [{ path: "/selected-state/state.sqlite", userVersion: 1 }],
    },
  });
  const { approvedPlan: _plan, approvedPlanDigest: _digest, ...facts } = context;
  const plan = {
    kind: "executable",
    mutationEnabled: true,
    actions: [
      "publish-authenticated-package",
      "target-maintenance-commit",
      "verify-managed-service",
    ],
    facts: recipeUpdateApprovalFacts(facts),
  };
  const digest = createHash("sha256").update(stableConfigStringify(plan)).digest("hex");
  return recipeUpdateContextSchema.parse({
    ...context,
    approvedPlanDigest: digest,
    approvedPlan: { ...plan, digest },
    maintenance: {
      ...context.maintenance,
      binding: { ...context.maintenance.binding, planDigest: digest },
    },
  });
}
