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

  async function setup() {
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
    const record = await fixture.store.createIntent({
      environmentId: "retained",
      providerId: fixture.provider.id,
      profileId: "development",
      provisionOperationId: "provision:retained",
      profileSnapshot: { ...profileSnapshot, project: { ...project, preparation } },
    });
    let artifactsCurrent = true;
    const prepareNodeArtifacts = vi.fn(async () => ({
      artifacts,
      assertCurrent: () => {
        if (!artifactsCurrent) {
          throw new Error("Runtime artifacts changed");
        }
      },
    }));
    const providerFor = vi.fn(() => fixture.provider);
    const owner = createWorkerProviderIntent({
      store: fixture.store,
      getConfig: () => fixture.config,
      projectNamespace: "gateway",
      providerFor,
      requireWorkerProfile: (value) => z.record(z.string(), z.json()).parse(value),
      prepareNodeArtifacts,
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
      prepareNodeArtifacts,
      providerFor,
      invalidateArtifacts: () => {
        artifactsCurrent = false;
      },
    };
  }

  it("uses repository admission and fences a changed source owner before allocation", async () => {
    const { owner, project } = await setup();
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
    const { owner, project } = await setup();
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
    const { project, record } = await setup();
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
    const { record, owner } = await setup();
    const retained = await owner.prepareRetention(record, fixture.abort.signal);
    expect(retained).toBeDefined();
    expect(retained!.isCurrent()).toBe(true);
    expect(sourceAdmission).not.toHaveBeenCalled();
    expect(fixture.store.get(record.environmentId)).toEqual(record);
    expect(() =>
      owner.assertPreparedIntentCurrent(record.profileId, {
        providerId: record.providerId,
        profileSnapshot: record.profileSnapshot,
      }),
    ).toThrow("not owned by this lifecycle");
  });

  it.each(["profile", "provider", "target", "owner selection", "agent deletion", "runtime"])(
    "rechecks %s drift without acquiring external source authority",
    async (mutation) => {
      const { record, owner, invalidateArtifacts } = await setup();
      const retained = await owner.prepareRetention(record, fixture.abort.signal);
      expect(retained).toBeDefined();
      if (mutation === "profile") {
        fixture.developmentProfile.settings = { region: "changed" };
      } else if (mutation === "provider") {
        fixture.developmentProfile.provider = "another-provider";
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
      if (mutation === "runtime") {
        expect(() => retained!.isCurrent()).toThrow("Runtime artifacts changed");
      } else {
        expect(retained!.isCurrent()).toBe(false);
        expect(await owner.prepareRetention(record, fixture.abort.signal)).toBeUndefined();
      }
      expect(sourceAdmission).not.toHaveBeenCalled();
    },
  );

  it.each(["owner selection", "agent deletion"] as const)(
    "rejects known %s drift while provider observation is unavailable",
    async (mutation) => {
      const { record, owner, providerFor } = await setup();
      const retained = await owner.prepareRetention(record, fixture.abort.signal);
      expect(retained?.isCurrent()).toBe(true);
      providerFor.mockClear().mockImplementation(() => {
        throw new Error("Worker provider registry temporarily unavailable");
      });
      if (mutation === "owner selection") {
        fixture.config.tools = { github: { kind: "oauth", profileId: `ghp_${"a".repeat(32)}` } };
      } else {
        fixture.config.agents = { list: [{ id: "other" }] };
      }

      expect(retained?.isCurrent()).toBe(false);
      expect(await owner.prepareRetention(record, fixture.abort.signal)).toBeUndefined();
      expect(providerFor).not.toHaveBeenCalled();
      expect(sourceAdmission).not.toHaveBeenCalled();
    },
  );

  it("distinguishes unavailable artifact observations from incompatible contents", async () => {
    const { record, owner, prepareNodeArtifacts } = await setup();
    const unavailable = new Error("Artifact archive temporarily unavailable");
    prepareNodeArtifacts.mockRejectedValueOnce(unavailable);

    await expect(owner.prepareRetention(record, fixture.abort.signal)).rejects.toBe(unavailable);
    expect((await owner.prepareRetention(record, fixture.abort.signal))?.isCurrent()).toBe(true);
    expect(fixture.store.get(record.environmentId)).toEqual(record);
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("rejects an old runtime fingerprint when reconstructing retention after restart", async () => {
    const { record, owner, artifacts } = await setup();
    artifacts.workerArchiveSha256 = "1".repeat(64);
    expect(await owner.prepareRetention(record, fixture.abort.signal)).toBeUndefined();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });
});
