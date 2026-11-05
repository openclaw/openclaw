import { describe, expect, it, vi } from "vitest";
import { createRepositorySourceFixture } from "../../plugins/repository-source.test-support.js";
import { createRepositorySources } from "../repository-sources.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { PROJECT_KEY, usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { prepareWorkerProviderProject } from "./provider-project-preparation.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { createRepositorySourcesFixture } from "./repository-source.test-support.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";

const sourceAdmission = vi.hoisted(() =>
  vi.fn<typeof import("./repository-project-admission.js").prepareRepositoryWorkerProjectSource>(),
);
vi.mock("./repository-project-admission.js", () => ({
  prepareRepositoryWorkerProjectSource: sourceAdmission,
}));

describe("prepared project retention compatibility", () => {
  const fixture = usePreparedPoolFixture();

  async function setup(
    native = false,
    source?: RepositoryWorkerProjectSnapshot["source"],
    repositorySources?: ReturnType<typeof createRepositorySources>,
  ) {
    sourceAdmission
      .mockReset()
      .mockRejectedValue(new Error("Retention must not access the repository"));
    fixture.config.agents = { entries: { main: {} } };
    const options = fixture.intentOwnerOptions("gateway");
    const { target, artifacts } = readWorkerPreparation(fixture.profile())!;
    fixture.provider.resolvePreparationTarget = () => target;
    const project: RepositoryWorkerProjectSnapshot = {
      key: PROJECT_KEY,
      baseCommit: "d".repeat(40),
      source: {
        kind: "repository",
        url: "https://github.com/openclaw/prepared-fixture.git",
        repositoryId: "R_prepared_fixture",
        repositorySourceId: "github-repositories/repositories",
        owner: {
          agent: { agentId: "main", provenance: null },
          identity: { source: "plugin", key: JSON.stringify({ source: "anonymous" }) },
        },
      },
    };
    if (source) {
      project.source = source;
    }
    if (native) {
      delete project.source.repositorySourceId;
      project.source.owner.identity = { source: "anonymous" };
    }
    const profileSnapshot = { settings: {}, install: "bundle", executionMode: "worker-turn" };
    const preparation = createWorkerPreparationIdentity({
      namespace: "gateway",
      providerId: fixture.provider.id,
      profileId: "development",
      profileSnapshot,
      project,
      target,
      artifacts,
      setupRecipe: "e".repeat(40),
      runSetupScript: false,
    });
    const preparedProfile = { ...profileSnapshot, project: { ...project, preparation } };
    const record = await fixture.store.createIntent({
      environmentId: "retained",
      providerId: fixture.provider.id,
      profileId: "development",
      provisionOperationId: "provision:retained",
      profileSnapshot: preparedProfile,
    });
    const prepareNodeArtifacts = vi.fn(async () => ({ artifacts, assertCurrent() {} }));
    const providerFor = vi.fn(() => fixture.provider);
    const sources = repositorySources ?? createRepositorySourcesFixture(() => fixture.config);
    const owner = createWorkerProviderIntent({
      ...options,
      getRepositorySources: () => sources,
      providerFor,
      prepareNodeArtifacts,
      resumeProvision: async (environment) => environment,
    });
    return {
      record,
      preparation: readWorkerPreparation(record.profileSnapshot)!,
      preparedProfile,
      owner,
      project,
      artifacts,
      prepareNodeArtifacts,
      providerFor,
    };
  }

  it("uses repository admission and fences a changed source owner before allocation", async () => {
    const { owner, project } = await setup();
    let current = true;
    sourceAdmission.mockResolvedValue({
      project,
      setupRecipe: "e".repeat(40),
      recipe: {
        source: "script",
        identity: "e".repeat(40),
        inputs: { ".openclaw/worktree-setup.sh": "e".repeat(40) },
        env: {},
        onCreate: ["./.openclaw/worktree-setup.sh"],
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Repository owner changed");
        }
      },
      revalidate: async () => {},
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
        { executionMode: "worker-turn" },
        intent,
      ),
    ).rejects.toThrow("Repository owner changed");
    expect(fixture.store.list()).toEqual(before);
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
      recipe: { source: "none", inputs: {}, env: {} },
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

  it.each([false, true])(
    "checks retained contents (native=%s) without source admission or allocation authority",
    async (native) => {
      const { record, preparation, preparedProfile, owner } = await setup(native);
      const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
      expect(retained).toBeDefined();
      expect(retained!.isCurrent()).toBe(true);
      expect(sourceAdmission).not.toHaveBeenCalled();
      expect(fixture.store.get(record.environmentId)).toEqual(record);
      expect(() =>
        owner.assertPreparedIntentCurrent(record.profileId, {
          providerId: record.providerId,
          profileSnapshot: preparedProfile,
        }),
      ).toThrow("not owned by this lifecycle");
    },
  );

  it.each(["identity selection", "plugin retirement"])(
    "retains plugin preparations independently of native GitHub selection until %s",
    async (change) => {
      let identityKey = "selected-reader";
      const source = createRepositorySourceFixture({
        id: "remote",
        resolve: (url) => ({ url, name: "project" }),
        prepare: async () => {
          throw new Error("Retention must not materialize the repository");
        },
        worker: {
          isIdentityCurrent: ({ agentId, identityKey: selected }) =>
            agentId === "main" && selected === identityKey,
          prepare: async () => {
            throw new Error("Retention must not acquire repository access");
          },
          checkout: async () => {
            throw new Error("Retention must not checkout the repository");
          },
        },
      });
      const { record, preparation, owner, prepareNodeArtifacts } = await setup(
        false,
        {
          kind: "repository",
          url: "https://git.example/team/subgroup/project",
          repositorySourceId: source.id,
          repositoryId: "repository_fixture",
          owner: {
            agent: { agentId: "main", provenance: null },
            identity: { source: "plugin", key: identityKey },
          },
        },
        createRepositorySources(fixture.abort.signal, source.registry),
      );
      fixture.config.plugins = {
        entries: {
          "github-repositories": {
            config: { system: { kind: "oauth", profileId: `ghp_${"a".repeat(32)}` } },
          },
        },
      };
      await source.run(async () => {
        const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
        expect(retained).toBeDefined();
        expect(retained!.isCurrent()).toBe(true);
        if (change === "identity selection") {
          identityKey = "replacement-reader";
        } else {
          await source.instance.dispose();
        }
        expect(retained!.isCurrent()).toBe(false);
        prepareNodeArtifacts.mockClear();
        expect(
          await owner.prepareRetention(record, preparation, fixture.abort.signal),
        ).toBeUndefined();
        expect(prepareNodeArtifacts).not.toHaveBeenCalled();
        expect(sourceAdmission).not.toHaveBeenCalled();
      });
    },
  );

  it.each(
    ["provider", "target", "owner selection", "agent deletion"].flatMap((mutation) =>
      [false, true].map((native) => ({ mutation, native })),
    ),
  )(
    "rejects $mutation drift (native=$native) without external source authority",
    async ({ mutation, native }) => {
      const { record, preparation, owner, providerFor } = await setup(native);
      const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
      expect(retained).toBeDefined();
      const unavailable = mutation === "owner selection" || mutation === "agent deletion";
      if (unavailable) {
        expect(retained?.isCurrent()).toBe(true);
        providerFor.mockClear().mockImplementation(() => {
          throw new Error("Worker provider registry temporarily unavailable");
        });
      }
      if (mutation === "provider") {
        fixture.developmentProfile.provider = "another-provider";
      } else if (mutation === "target") {
        fixture.provider.resolvePreparationTarget = () => ({
          machineClass: "large",
          platform: "linux",
          arch: "x64",
        });
      } else if (mutation === "owner selection") {
        fixture.config.plugins = {
          entries: {
            "github-repositories": {
              config: { system: { kind: "oauth", profileId: `ghp_${"a".repeat(32)}` } },
            },
          },
        };
      } else {
        fixture.config.agents = { entries: { other: {} } };
      }
      if (unavailable) {
        expect(retained?.isCurrent()).toBe(false);
      }
      expect(
        await owner.prepareRetention(record, preparation, fixture.abort.signal),
      ).toBeUndefined();
      if (unavailable) {
        expect(providerFor).not.toHaveBeenCalled();
      }
      expect(sourceAdmission).not.toHaveBeenCalled();
    },
  );

  it("rejects agent removal during lifecycle preparation before preparing artifacts", async () => {
    const { record, preparation, owner, prepareNodeArtifacts } = await setup();
    const pending = owner.prepareRetention(record, preparation, fixture.abort.signal);
    fixture.config.agents = { entries: { other: {} } };

    await expect(pending).resolves.toBeUndefined();
    expect(prepareNodeArtifacts).not.toHaveBeenCalled();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("rejects an old runtime fingerprint on the first retention pass after restart", async () => {
    const { record, preparation, owner, artifacts } = await setup();
    artifacts.workerArchiveSha256 = "1".repeat(64);
    expect(await owner.prepareRetention(record, preparation, fixture.abort.signal)).toBeUndefined();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("reports why activation demand cannot refill after runtime artifacts change", async () => {
    const { record, owner, artifacts } = await setup();
    const activated = await fixture.attach(await fixture.ready(record));
    artifacts.workerArchiveSha256 = "1".repeat(64);
    const warn = vi.fn();
    const pool = fixture.pool({ prepareRetention: owner.prepareRetention, warn });
    await pool.maintain(activated.environmentId);
    expect(fixture.reserves()).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Prepared worker refill skipped (development, retained): runtime artifacts or preparation identity changed",
    );
  });
});
