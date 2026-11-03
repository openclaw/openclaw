import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import {
  findCredential,
  findWorkerEnvironment,
} from "../gateway/worker-environments/store-row-codec.js";
import { createWorkerEnvironmentStoreKernel } from "../gateway/worker-environments/store.kernel.js";
import {
  workerCredential,
  workerReadyPatch,
} from "../gateway/worker-environments/store.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { prepareSkillLibraryBundle } from "../skills/library/bundle.js";
import { ensureSkillLibrarySchema } from "../skills/library/store.js";
import { captureDatabaseArtifact } from "../snapshot/database-backup.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  bindSessionRepositoryWorkspaceBaseInDatabase,
  acceptSessionRepositoryWorkspaceCheckpointInDatabase,
  createSessionRepositoryWorkspaceInDatabase,
} from "../state/session-repository-workspaces.kernel.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { restoreSessionDependencies } from "./database-restore-session-dependencies.js";

it("restores a sealed missing retained owner through the offline command without reviving credentials", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", scenario: "minimal" });
  try {
    const profile = {
      provider: "synthetic",
      install: "bundle" as const,
      settings: {},
      workspaceDurability: { mode: "retained-disk" as const, computeWindowSeconds: 600 },
    };
    await state.writeConfig({
      plugins: { enabled: false },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      cloudWorkers: { profiles: { retained: profile } },
    });
    const owner = ensureGatewayOwnerProfile("Recovery owner", { env: state.env });
    const identity = {
      sessionId: randomUUID(),
      agentId: "main",
      sessionKey: "agent:main:retained-recovery",
    };
    const environmentId = "retained-environment";
    const receipt = {
      version: 1 as const,
      leaseId: "original-lease",
      identity: { diskId: "original-disk" },
    };
    let database = openOpenClawStateDatabase({ env: state.env });
    const environment = runOpenClawStateWriteTransaction(
      () => {
        const kernel = createWorkerEnvironmentStoreKernel(database, () => 1000);
        kernel.createIntent({
          environmentId,
          providerId: "synthetic",
          profileId: "retained",
          profileSnapshot: {
            install: "bundle",
            settings: {},
            workspaceDurability: profile.workspaceDurability,
            executionMode: "worker-turn",
            machineClass: "synthetic-small",
            os: "linux",
          },
          provisionOperationId: "original-provision",
          retention: { version: 1, ownerBinding: identity.sessionId, computeWindowSeconds: 600 },
        });
        kernel.ensureNodeEnrollment(environmentId);
        kernel.transition({ environmentId, from: "requested", to: "provisioning" });
        kernel.recordResourceReceipt({
          environmentId,
          provisionOperationId: "original-provision",
          receipt,
        });
        kernel.transition({
          environmentId,
          from: "provisioning",
          to: "ready",
          patch: workerReadyPatch(receipt.leaseId, "original-node"),
        });
        const attached = kernel.transition({
          environmentId,
          from: "ready",
          to: "attached",
          patch: {
            attachedSessionIds: [identity.sessionId],
            credential: workerCredential("c".repeat(43), identity.sessionId),
          },
        });
        kernel.recordRetentionObservation({
          environmentId,
          expectedOwnerEpoch: attached.ownerEpoch,
          observation: {
            claimRevision: "claim",
            state: "running",
            computeExpiresAtMs: Number.MAX_SAFE_INTEGER,
          },
        });
        return kernel.setRetentionRuntimeAdmission({
          environmentId,
          expectedOwnerEpoch: attached.ownerEpoch,
          expectedClaimRevision: "claim",
          ready: true,
        });
      },
      { database },
    );
    const placements = createWorkerSessionPlacementStore({ database, now: () => 1000 });

    const workspace = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const created = createSessionRepositoryWorkspaceInDatabase(
          db,
          { ...identity, url: "https://example.invalid/project.git" },
          1000,
        ).workspace!;
        const based = bindSessionRepositoryWorkspaceBaseInDatabase(
          db,
          {
            workspaceId: created.workspaceId,
            expectedRevision: created.revision,
            baseCommit: "a".repeat(40),
            baseManifestHash: "sha256:" + "b".repeat(64),
          },
          1000,
        ).workspace!;
        return acceptSessionRepositoryWorkspaceCheckpointInDatabase(
          db,
          {
            workspaceId: based.workspaceId,
            expectedRevision: based.revision,
            checkpointRef: "refs/openclaw/worker-results/initial",
            manifestHash: "sha256:" + "b".repeat(64),
          },
          1000,
        ).workspace!;
      },
      { database },
    );
    let placement = await placements.startDispatch(identity);
    placement = await placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId },
    });
    placement = await placements.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = await placements.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: workspace.manifestHash!,
        remoteWorkspaceDir: "/workspace/retained",
      },
    });
    await placements.transition({
      sessionId: identity.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: environment.ownerEpoch },
      repositoryDiskWorkspaceId: workspace.workspaceId,
    });
    // A retained disk may have no local checkpoint; preserve only its original resource authority.
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_repository_workspaces")
            .set({ checkpoint_ref: null, manifest_hash: null })
            .where("workspace_id", "=", workspace.workspaceId),
        );
      },
      { database },
    );
    const skillId = randomUUID();
    const content =
      "---\nname: recovery\ndescription: Recovery instructions\n---\n# Preserve original disk\n";
    const skill = prepareSkillLibraryBundle([{ path: "SKILL.md", content }]);
    ensureSkillLibrarySchema({ database, env: state.env }, () => {});
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const query = getNodeSqliteKysely<DB>(db);
        executeSqliteQuerySync(
          db,
          query.insertInto("skill_library_entries").values({
            skill_id: skillId,
            owner_profile_id: owner.id,
            author_profile_id: owner.id,
            slug: "recovery",
            current_revision: skill.revision,
            shared: 0,
            enabled: 0,
            removed: 0,
            created_at: 1,
            updated_at: 1,
          }),
        );
        executeSqliteQuerySync(
          db,
          query.insertInto("skill_library_revisions").values({
            skill_id: skillId,
            revision: skill.revision,
            description: skill.description,
            files_json: JSON.stringify(skill.files.map(({ bytes: _bytes, ...file }) => file)),
            created_at: 1,
          }),
        );
      },
      { database },
    );
    await replaceSessionEntry(
      {
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: identity.sessionKey,
        env: state.env,
      },
      {
        sessionId: identity.sessionId,
        updatedAt: 1,
        repositoryWorkspaceId: workspace.workspaceId,
        skillLibrarySelections: [
          { skillId, revision: skill.revision, name: "recovery", ownerProfileId: owner.id },
        ],
      },
    );
    await closeOpenClawStateDatabaseAsync();
    const input = state.path("retained-bundle");
    await fs.mkdir(path.join(input, "skill-revision"), { recursive: true });
    await fs.writeFile(path.join(input, "skill-revision/SKILL.md"), content);
    await fs.copyFile(state.statePath("state/openclaw.sqlite"), path.join(input, "shared.sqlite"));
    database = openOpenClawStateDatabase({ env: state.env });
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const query = getNodeSqliteKysely<DB>(db);
        executeSqliteQuerySync(
          db,
          query
            .deleteFrom("worker_session_placements")
            .where("session_id", "=", identity.sessionId),
        );
        executeSqliteQuerySync(
          db,
          query
            .deleteFrom("session_repository_workspaces")
            .where("workspace_id", "=", workspace.workspaceId),
        );
        executeSqliteQuerySync(
          db,
          query.deleteFrom("worker_environments").where("environment_id", "=", environmentId),
        );
      },
      { database },
    );
    await closeOpenClawStateDatabaseAsync();
    await fs.copyFile(
      state.statePath("state/openclaw.sqlite"),
      path.join(input, "expected.sqlite"),
    );
    const request = JSON.stringify({
      version: 1,
      sourceSha256: (await captureDatabaseArtifact(path.join(input, "shared.sqlite"))).sha256,
      profileId: owner.id,
      ...identity,
      skillId,
      skillRevision: skill.revision,
      workspaceId: workspace.workspaceId,
      retained: {
        expectedSha256: (await captureDatabaseArtifact(path.join(input, "expected.sqlite"))).sha256,
      },
    });
    await fs.writeFile(path.join(input, "request.json"), request);
    const sha256 = createHash("sha256").update(request).digest("hex");
    const configBytes = await fs.readFile(state.configPath, "utf8");
    await state.writeConfig({
      plugins: { enabled: false },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      cloudWorkers: { profiles: { retained: { ...profile, settings: { region: "changed" } } } },
    });
    await expect(restoreSessionDependencies({ input, sha256 })).rejects.toThrow(
      "Current worker profile differs",
    );
    await fs.writeFile(state.configPath, configBytes);
    // Separate CLI invocations do not share the first invocation's resident configuration.
    clearRuntimeConfigSnapshot();
    await expect(restoreSessionDependencies({ input, sha256 })).resolves.toMatchObject({
      ok: true,
      executionReady: false,
      retainedOwner: { environmentId, workspaceId: workspace.workspaceId },
    });
    database = openOpenClawStateDatabase({ env: state.env });
    expect(findWorkerEnvironment(database.db, environmentId)).toMatchObject({
      resourceReceipt: receipt,
      retention: { runtimeReady: false },
      nodeSetupId: null,
      sshEndpoint: null,
    });
    expect(findCredential(database.db, environmentId)).toBeUndefined();
    await closeOpenClawStateDatabaseAsync();
    await expect(restoreSessionDependencies({ input, sha256 })).rejects.toThrow(
      "selection changed",
    );
  } finally {
    await state.cleanup();
  }
});
