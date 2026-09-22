import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

describe("prepared worker intent admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture(setup = false) {
    const projectPath = path.join(support.testState.root, "project");
    await fs.mkdir(projectPath);
    await requireGit(projectPath, ["init", "--quiet"]);
    await requireGit(projectPath, ["config", "user.name", "Project Test"]);
    await requireGit(projectPath, ["config", "user.email", "project@example.invalid"]);
    await requireGit(projectPath, ["config", "commit.gpgsign", "false"]);
    await fs.writeFile(path.join(projectPath, "input.txt"), "base\n");
    if (setup) {
      await fs.mkdir(path.join(projectPath, ".openclaw"));
      await fs.writeFile(
        path.join(projectPath, ".openclaw/worktree-setup.sh"),
        "#!/bin/sh\ntrue\n",
        {
          mode: 0o755,
        },
      );
    }
    await requireGit(projectPath, ["add", "."]);
    await requireGit(projectPath, ["commit", "--quiet", "-m", "base"]);
    const target = vi.fn<NonNullable<WorkerProvider["resolvePreparationTarget"]>>(
      (_profile, machineClass, os) => ({
        machineClass: machineClass ?? "small",
        platform: os ?? "linux",
        arch: "amd64",
      }),
    );
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: target,
    });
    let artifactsCurrent = true;
    const artifacts = {
      nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
      workerBundleHash: support.BUNDLE_ARTIFACT.bundleHash,
      workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
      enabledPluginIds: ["runtime-plugin"],
      openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
      protocolFeatures: [],
    };
    const prepareNodeArtifacts = vi.fn(async () => ({
      artifacts,
      assertCurrent: () => {
        if (!artifactsCurrent) {
          throw new Error("runtime changed");
        }
      },
    }));
    const resumeProvision = vi.fn(async (record: WorkerEnvironmentRecord) => record);
    const owner = createWorkerProviderIntent({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      projectNamespace: "gateway-test",
      providerFor: () => provider,
      requireWorkerProfile: (value) => {
        const error = validateCloudWorkerProfileSettings(value);
        if (error) {
          throw new Error(error);
        }
        return value as Parameters<WorkerProvider["provision"]>[0];
      },
      prepareNodeArtifacts,
      resumeProvision,
      isStopping: () => false,
      inState: (record, ...states) => states.includes(record.state),
      withLock: async (_environmentId, task) => task(),
      serviceError: (_code, message) => new Error(message),
    });
    return {
      owner,
      provider,
      projectPath,
      target,
      prepareNodeArtifacts,
      resumeProvision,
      invalidateArtifacts: () => {
        artifactsCurrent = false;
      },
    };
  }

  it("admits exact local source and OS without allocating, and retains reusable facts after caller abort", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const options = {
      projectPath: f.projectPath,
      machineClass: "large",
      os: "linux",
      signal: controller.signal,
    };
    const intent = await f.owner.prepareIntent("development", options);
    expect(intent.preparationKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.target).toHaveBeenCalledWith({ region: "test" }, "large", "linux");
    expect(support.testState.store.list()).toEqual([]);
    expect(f.resumeProvision).not.toHaveBeenCalled();
    controller.abort();
    expect(() => f.owner.assertPreparedIntentCurrent("development", intent)).not.toThrow();
    await f.owner.createWithProfile(
      "development",
      "admitted-local",
      { ...options, signal: undefined },
      intent,
    );
    expect(support.testState.store.list()).toHaveLength(1);
    expect(f.resumeProvision).toHaveBeenCalledOnce();
    f.invalidateArtifacts();
    expect(() => f.owner.assertPreparedIntentCurrent("development", intent)).toThrow(
      "runtime changed",
    );
  });

  it("replays a removed linked source through its canonical repository while rejecting other projects and commits", async () => {
    const f = await fixture();
    const linked = path.join(support.testState.root, "linked-source");
    await requireGit(f.projectPath, ["worktree", "add", "--detach", linked, "HEAD"]);
    await fs.writeFile(path.join(linked, "input.txt"), "session commit\n");
    await requireGit(linked, ["commit", "--quiet", "-am", "session"]);
    const options = { projectPath: linked };
    const admitted = await f.owner.prepareIntent("development", options);
    const stored = await f.owner.createWithProfile(
      "development",
      "linked-replay",
      options,
      admitted,
    );
    await fs.writeFile(path.join(f.projectPath, "input.txt"), "new primary commit\n");
    await requireGit(f.projectPath, ["commit", "--quiet", "-am", "advance primary"]);
    const primaryCommit = await requireGit(f.projectPath, ["rev-parse", "HEAD"]);
    await requireGit(f.projectPath, ["worktree", "remove", linked]);

    await expect(
      f.owner.createWithProfile("development", "linked-replay", {
        projectPath: f.projectPath,
      }),
    ).resolves.toMatchObject({
      environmentId: stored.environmentId,
      profileSnapshot: stored.profileSnapshot,
    });
    const nested = path.join(f.projectPath, "nested");
    await fs.mkdir(nested);
    await expect(
      f.owner.createWithProfile("development", "linked-replay", { projectPath: nested }),
    ).resolves.toMatchObject({
      environmentId: stored.environmentId,
      profileSnapshot: stored.profileSnapshot,
    });
    expect(
      (await f.owner.prepareIntent("development", { projectPath: nested })).profileSnapshot.project,
    ).toBeUndefined();

    const other = path.join(support.testState.root, "other-clone");
    await requireGit(support.testState.root, ["clone", "--no-hardlinks", f.projectPath, other]);
    await expect(
      f.owner.createWithProfile("development", "linked-replay", {
        projectPath: other,
      }),
    ).rejects.toThrow("Idempotency key belongs to another project");
    await expect(
      f.owner.createWithProfile("development", "linked-replay", {
        projectPath: f.projectPath,
        projectCommit: primaryCommit,
      }),
    ).rejects.toThrow("Idempotency key belongs to another project preparation");
    const changed = await f.owner.prepareIntent("development", { projectPath: f.projectPath });
    await expect(
      f.owner.createWithProfile(
        "development",
        "linked-replay",
        {
          projectPath: f.projectPath,
        },
        changed,
      ),
    ).rejects.toThrow("Idempotency key belongs to another project preparation");
    expect(support.testState.store.get(stored.environmentId)?.profileSnapshot).toEqual(
      stored.profileSnapshot,
    );
    expect(f.resumeProvision).toHaveBeenCalledTimes(3);
  });

  it.each(["current", "legacy-label", "linked-transport"])(
    "replays a fresh admitted intent after display or transport metadata changes (%s)",
    async (variant) => {
      const f = await fixture();
      const options = { projectPath: f.projectPath };
      const original = await f.owner.prepareIntent("development", options);
      const profileSnapshot = structuredClone(original.profileSnapshot);
      if (!isRecord(profileSnapshot.project)) {
        throw new Error("Expected prepared project");
      }
      if (variant === "legacy-label") {
        delete profileSnapshot.project.label;
      } else if (variant === "linked-transport") {
        const linked = path.join(support.testState.root, "previous-transport");
        await requireGit(f.projectPath, ["worktree", "add", "--detach", linked, "HEAD"]);
        profileSnapshot.project.root = linked;
      }
      const stored = support.testState.store.createIntent({
        ...deriveEnvironmentIntent("display-replay"),
        providerId: original.providerId,
        profileId: "development",
        profileSnapshot,
      });
      await requireGit(f.projectPath, [
        "remote",
        "add",
        "origin",
        "git@example.invalid:Team/Renamed.git",
      ]);
      const retry = await f.owner.prepareIntent("development", options);
      expect(retry.preparationKey).toBe(original.preparationKey);
      await expect(
        f.owner.createWithProfile("development", "display-replay", options, retry),
      ).resolves.toMatchObject({ environmentId: stored.environmentId, profileSnapshot });
      expect(support.testState.store.get(stored.environmentId)?.profileSnapshot).toEqual(
        profileSnapshot,
      );
      expect(f.resumeProvision).toHaveBeenCalledOnce();

      await fs.writeFile(path.join(f.projectPath, "input.txt"), "changed source\n");
      await requireGit(f.projectPath, ["commit", "--quiet", "-am", "change source"]);
      const changed = await f.owner.prepareIntent("development", options);
      await expect(
        f.owner.createWithProfile("development", "display-replay", options, changed),
      ).rejects.toThrow("Idempotency key belongs to another project preparation");
      expect(f.resumeProvision).toHaveBeenCalledOnce();
    },
  );

  it("requires setup authority for reserves while preserving explicit session setup admission", async () => {
    const f = await fixture(true);
    const ordinary = await f.owner.prepareIntent("development", { projectPath: f.projectPath });
    expect(ordinary.preparationKey).toBeUndefined();
    const authorized = await f.owner.prepareIntent("development", {
      projectPath: f.projectPath,
      setupAuthorized: true,
    });
    const skipped = await f.owner.prepareIntent("development", {
      projectPath: f.projectPath,
      runSetupScript: false,
    });
    expect(authorized.preparationKey).toBeDefined();
    expect(skipped.preparationKey).toBeDefined();
    expect(skipped.preparationKey).not.toBe(authorized.preparationKey);
    await f.owner.createWithProfile("development", "session-setup", {
      projectPath: f.projectPath,
      runSetupScript: true,
    });
    expect(
      readWorkerProjectPreparation(support.testState.store.list()[0]!.profileSnapshot.project)?.key,
    ).toBe(authorized.preparationKey);
  });

  it("rejects copied or modified intent objects and profile drift before an allocation can be recorded", async () => {
    const f = await fixture();
    const intent = await f.owner.prepareIntent("development", { projectPath: f.projectPath });
    expect(() =>
      f.owner.assertPreparedIntentCurrent("development", structuredClone(intent)),
    ).toThrow("not owned by this lifecycle");
    const originalSnapshot = intent.profileSnapshot;
    intent.profileSnapshot = { ...originalSnapshot, os: "windows" };
    expect(() => f.owner.assertPreparedIntentCurrent("development", intent)).toThrow(
      "changed after preparation",
    );
    intent.profileSnapshot = originalSnapshot;
    support.getDevelopmentProfile().settings = { region: "changed" };
    await expect(
      f.owner.createWithProfile("development", "stale-profile", {}, intent),
    ).rejects.toThrow("profile changed during preparation");
    expect(support.testState.store.list()).toEqual([]);
  });

  it("rechecks profile policy after awaited artifact preparation and during retention", async () => {
    const f = await fixture();
    const intent = await f.owner.prepareIntent("development", { projectPath: f.projectPath });
    const record = support.testState.store.createIntent({
      environmentId: "retained",
      providerId: intent.providerId,
      profileId: "development",
      profileSnapshot: intent.profileSnapshot,
      provisionOperationId: "provision-retained",
    });
    const retention = await f.owner.prepareRetention(record);
    expect(retention).toBeDefined();
    f.provider.supportsProjectPreparation = () => false;
    expect(() => retention!.assertCurrent()).toThrow("retention policy changed");
    f.provider.supportsProjectPreparation = () => true;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const original = f.prepareNodeArtifacts.getMockImplementation()!;
    f.prepareNodeArtifacts.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return original();
    });
    const pending = f.owner.prepareIntent("development", { projectPath: f.projectPath });
    await entered.promise;
    support.getDevelopmentProfile().settings = { region: "changed" };
    release.resolve();
    await expect(pending).rejects.toThrow("profile changed during preparation");
  });
});
