import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createWorkerProjectPreparationIdentity } from "./preparation-identity.js";
import { PROJECT_KEY, usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { prepareWorkerProviderProject } from "./provider-project-preparation.js";
import {
  workerProjectSeedKey,
  type RepositoryWorkerProjectSnapshot,
} from "./workspace-git-base.js";

const sourceAdmission = vi.hoisted(() =>
  vi.fn<typeof import("./repository-project-admission.js").prepareRepositoryWorkerProjectSource>(),
);
vi.mock("./repository-project-admission.js", () => ({
  prepareRepositoryWorkerProjectSource: sourceAdmission,
}));

describe("prepared project retention compatibility", () => {
  const fixture = usePreparedPoolFixture();

  function setup() {
    sourceAdmission
      .mockReset()
      .mockRejectedValue(new Error("Retention must not access the repository"));
    fixture.config.agents = { list: [{ id: "main" }] };
    fixture.provider.requiresNodeEnrollment = true;
    fixture.provider.supportsProjectPreparation = () => true;
    fixture.provider.resolvePreparationTarget = () => ({
      machineClass: "standard",
      platform: "linux",
      arch: "x64",
    });
    const project: RepositoryWorkerProjectSnapshot = {
      key: PROJECT_KEY,
      baseCommit: "d".repeat(40),
      source: {
        kind: "repository",
        url: "https://github.com/openclaw/prepared-fixture.git",
        repositoryId: "R_prepared_fixture",
        owner: {
          agent: { agentId: "main", provenance: null },
          identity: { source: "anonymous" },
        },
      },
    };
    const profileSnapshot = { settings: {}, install: "bundle", executionMode: "worker-turn" };
    const artifacts = {
      nodeBootstrapSha256: "e".repeat(64),
      enabledPluginIds: [],
      workerBundleHash: "c".repeat(64),
      workerArchiveSha256: "f".repeat(64),
      openclawVersion: "2026.8.1",
      protocolFeatures: [],
    };
    const preparation = createWorkerProjectPreparationIdentity({
      namespace: "gateway",
      providerId: fixture.provider.id,
      profileId: "development",
      profileSnapshot,
      project,
      target: { machineClass: "standard", platform: "linux", arch: "x64" },
      artifacts,
      setupRecipe: "e".repeat(40),
      runSetupScript: false,
    });
    const record = fixture.store.createIntent({
      environmentId: "retained",
      providerId: fixture.provider.id,
      profileId: "development",
      provisionOperationId: "provision:retained",
      profileSnapshot: { ...profileSnapshot, project: { ...project, preparation } },
    });
    let artifactsCurrent = true;
    const owner = createWorkerProviderIntent({
      store: fixture.store,
      getConfig: () => fixture.config,
      projectNamespace: "gateway",
      providerFor: () => fixture.provider,
      requireWorkerProfile: (value) => z.record(z.string(), z.json()).parse(value),
      prepareNodeArtifacts: async () => ({
        artifacts,
        assertCurrent: () => {
          if (!artifactsCurrent) {
            throw new Error("Runtime artifacts changed");
          }
        },
      }),
      isStopping: () => false,
      inState: () => false,
      withLock: async (_id, run) => await run(),
      serviceError: (_code, message) => new Error(message),
      resumeProvision: async (environment) => environment,
    });
    return {
      record,
      owner,
      project,
      artifacts,
      invalidateArtifacts: () => {
        artifactsCurrent = false;
      },
    };
  }

  it("uses repository admission and fences a changed source owner before allocation", async () => {
    const { owner, project } = setup();
    let current = true;
    sourceAdmission.mockImplementation(async (request) => {
      request.assertCurrent();
      return {
        project,
        setupRecipe: "e".repeat(40),
        assertCurrent: () => {
          if (!current) {
            throw new Error("Repository owner changed");
          }
        },
        revalidate: async () => {},
      };
    });
    const intent = await owner.prepareIntent("development", {
      executionMode: "worker-turn",
      projectRepository: project,
      runSetupScript: false,
    });
    expect(sourceAdmission).toHaveBeenCalledOnce();
    expect(sourceAdmission.mock.calls[0]?.[0].expected).toEqual(project);
    expect(intent.profileSnapshot.project).toMatchObject({
      ...project,
      preparation: { setupRecipe: "e".repeat(40), runSetupScript: false },
    });
    expect(intent.profileSnapshot.project).not.toHaveProperty("root");
    current = false;
    const before = fixture.store.list();
    await expect(
      owner.createWithProfile(
        "development",
        "changed-repository",
        {
          executionMode: "worker-turn",
        },
        intent,
      ),
    ).rejects.toThrow("Repository owner changed");
    expect(fixture.store.list()).toEqual(before);
  });

  it("keeps providers without project preparation on ordinary cold provisioning", async () => {
    const { owner, project } = setup();
    fixture.provider.supportsProjectPreparation = () => false;
    const options = {
      executionMode: "worker-turn" as const,
      repository: { agentId: "main", url: project.source.url },
      runSetupScript: true,
      setupAuthorized: true,
    };
    const intent = await owner.prepareIntent("development", options);
    expect(intent.preparationKey).toBeUndefined();
    expect(intent.profileSnapshot).not.toHaveProperty("project");
    const cold = await owner.createWithProfile("development", "private-cold", options, intent);
    expect(cold.profileSnapshot).not.toHaveProperty("project");
    expect(cold.preparation).toBeNull();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("passes private pack production through the provisioning owner instead of worker fetch", async () => {
    const { project, record } = setup();
    const stopped = new Error("Private pack producer stopped before transfer");
    const prepareGitPack = vi.fn(async () => {
      throw stopped;
    });
    sourceAdmission.mockResolvedValue({
      project,
      setupRecipe: undefined,
      assertCurrent: () => {},
      revalidate: async () => {},
      prepareGitPack,
    });
    const operation = await prepareWorkerProviderProject({
      project,
      preparation: undefined,
      record,
      namespace: "gateway",
      getConfig: () => fixture.config,
      requireCurrent: () => {},
      signal: fixture.abort.signal,
    });
    const runScript = vi.fn(async () =>
      JSON.stringify({
        ready: false,
        directory: `/node/.openclaw-worker/git-seeds/gateway/.tmp-${workerProjectSeedKey(project)}-fixture`,
      }),
    );
    const upload = vi.fn();
    try {
      await expect(operation.project.prepare({ runScript, upload })).rejects.toBe(stopped);
      expect(prepareGitPack).toHaveBeenCalledOnce();
      expect(runScript).toHaveBeenCalledOnce();
      expect(upload).not.toHaveBeenCalled();
    } finally {
      operation.close();
    }
  });

  it("checks canonical retained contents without source admission or an allocation authority", async () => {
    const { record, owner } = setup();
    const retained = await owner.prepareRetention(record, fixture.abort.signal);
    expect(retained).toBeDefined();
    expect(() => retained!.assertCurrent()).not.toThrow();
    expect(sourceAdmission).not.toHaveBeenCalled();
    expect(fixture.store.get(record.environmentId)).toEqual(record);
    expect(() =>
      owner.assertPreparedIntentCurrent(record.profileId, {
        providerId: record.providerId,
        profileSnapshot: record.profileSnapshot,
      }),
    ).toThrow("not owned by this lifecycle");
  });

  it.each(["profile", "target", "owner selection", "agent deletion", "runtime"])(
    "rechecks %s drift without acquiring external source authority",
    async (mutation) => {
      const { record, owner, invalidateArtifacts } = setup();
      const retained = await owner.prepareRetention(record, fixture.abort.signal);
      expect(retained).toBeDefined();
      if (mutation === "profile") {
        fixture.developmentProfile.settings = { region: "changed" };
      } else if (mutation === "target") {
        fixture.provider.resolvePreparationTarget = () => ({
          machineClass: "large",
          platform: "linux",
          arch: "x64",
        });
      } else if (mutation === "owner selection") {
        fixture.config.tools = { github: { kind: "oauth", profileId: `ghp_${"a".repeat(32)}` } };
      } else if (mutation === "agent deletion") {
        fixture.config.agents = { list: [{ id: "other" }] };
      } else {
        invalidateArtifacts();
      }
      expect(() => retained!.assertCurrent()).toThrow();
      expect(sourceAdmission).not.toHaveBeenCalled();
    },
  );

  it("rejects an old runtime fingerprint when reconstructing retention after restart", async () => {
    const { record, owner, artifacts } = setup();
    artifacts.workerArchiveSha256 = "1".repeat(64);
    expect(await owner.prepareRetention(record, fixture.abort.signal)).toBeUndefined();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });
});
