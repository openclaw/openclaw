import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import * as support from "./service.test-support.js";
import * as workspaceGitBase from "./workspace-git-base.js";

describe("on-demand prepared worker admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture() {
    const projectPath = path.join(support.testState.root, "project");
    await fs.mkdir(projectPath);
    await requireGit(projectPath, ["init", "--quiet"]);
    await requireGit(projectPath, ["config", "user.name", "Project Test"]);
    await requireGit(projectPath, ["config", "user.email", "project@example.invalid"]);
    await requireGit(projectPath, ["config", "commit.gpgsign", "false"]);
    await fs.mkdir(path.join(projectPath, ".openclaw"));
    await fs.writeFile(path.join(projectPath, ".openclaw/worktree-setup.sh"), "#!/bin/sh\ntrue\n", {
      mode: 0o755,
    });
    await requireGit(projectPath, ["add", "."]);
    await requireGit(projectPath, ["commit", "--quiet", "-m", "base"]);
    const provision = vi.fn<WorkerProvider["provision"]>(async () => {
      throw new Error("Synthetic provider unavailable");
    });
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportedExecutionModes: ["worker-turn", "remote-exec"],
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux", arch: "x64" }),
      resolvePreparedIdleTimeoutMs: () => 10_000,
      provision,
    });
    const service = support.createService(provider, {
      projectNamespace: "gateway-test",
      prepareNodeEnrollment: async () => {
        throw new Error("Synthetic provider must not enroll");
      },
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: ["runtime-plugin"],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }),
    });
    return {
      service,
      provider,
      projectPath,
      provision,
      request: { profileId: "development", projectPath },
    };
  }

  it("admits HEAD without a session, authorizes setup, and starts background preparation", async () => {
    const f = await fixture();
    support.getDevelopmentProfile().readyWorkers = 0;
    const result = await f.service.prepare(f.request);
    const record = support.testState.store.get(result.environmentId)!;
    expect(result).toEqual({
      environmentId: record.environmentId,
      preparationKey: record.preparation!.key,
      reused: false,
    });
    expect(record).toMatchObject({
      profileId: "development",
      attachedSessionIds: [],
      profileSnapshot: {
        executionMode: "worker-turn",
        project: {
          root: f.projectPath,
          baseCommit: await requireGit(f.projectPath, ["rev-parse", "HEAD"]),
        },
      },
      preparation: { purpose: "build", demandAtMs: 1_000, expiresAtMs: 11_000, consumedAtMs: null },
    });
    expect(readWorkerProjectPreparation(record.profileSnapshot.project)?.setupRecipe).toMatch(
      /^[a-f0-9]{40}$/u,
    );
    await support.waitForFast(() => expect(f.provision).toHaveBeenCalledOnce());
    expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toBeNull();
    expect(f.service.list()[0]?.preparation).toMatchObject({
      purpose: "build",
      key: result.preparationKey,
    });
  });

  it.each(["build", "reserve"] as const)(
    "atomically reuses an existing %s even when the pool is full",
    async (purpose) => {
      const f = await fixture();
      support.getDevelopmentProfile().readyWorkers = 0;
      support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
      const intent = await f.service.prepareProjectIntent("development", {
        projectPath: f.projectPath,
        executionMode: "worker-turn",
        setupAuthorized: true,
      });
      const existing = support.testState.store.createIntent({
        environmentId: "existing-prepared",
        provisionOperationId: "existing-operation",
        providerId: intent.providerId,
        profileId: "development",
        profileSnapshot: intent.profileSnapshot,
        preparation: {
          purpose,
          key: intent.preparationKey!,
          demandAtMs: 1_000,
          expiresAtMs: 11_000,
        },
      });
      const results = await Promise.all([
        f.service.prepare(f.request),
        f.service.prepare(f.request),
      ]);
      expect(results).toEqual(
        [0, 1].map(() => ({
          environmentId: existing.environmentId,
          preparationKey: existing.preparation!.key,
          reused: true,
        })),
      );
      expect(support.testState.store.list()).toHaveLength(1);
      expect(support.testState.store.get(existing.environmentId)?.preparation?.purpose).toBe(
        "build",
      );
    },
  );

  it("uses the admitted profile's idle timeout after configuration changes during Git validation", async () => {
    const f = await fixture();
    f.provider.resolvePreparedIdleTimeoutMs = (settings) =>
      typeof settings.idleTimeoutMs === "number" ? settings.idleTimeoutMs : 10_000;
    const original = workspaceGitBase.prepareWorkerProjectSnapshot;
    const snapshot = vi
      .spyOn(workspaceGitBase, "prepareWorkerProjectSnapshot")
      .mockImplementationOnce(async (params) => {
        const project = await original(params);
        support.testState.config.cloudWorkers!.profiles!.development = {
          ...support.getDevelopmentProfile(),
          settings: { region: "test", idleTimeoutMs: 20_000 },
        };
        return project;
      });
    try {
      const result = await f.service.prepare(f.request);
      expect(support.testState.store.get(result.environmentId)?.preparation?.expiresAtMs).toBe(
        21_000,
      );
    } finally {
      snapshot.mockRestore();
    }
  });

  it.each(["build", "reserve", "expired reserve"] as const)(
    "cancels an in-flight %s while retaining cleanup ownership until the provider settles",
    async (purpose) => {
      const f = await fixture();
      const entered = createDeferredCore<AbortSignal>();
      const release = createDeferredCore();
      let provisionSettled = false;
      f.provision.mockImplementation(async (_profile, _operation, options) => {
        const signal = options!.signal!;
        entered.resolve(signal);
        try {
          await release.promise;
          signal.throwIfAborted();
          throw new Error("Synthetic provider unavailable");
        } finally {
          provisionSettled = true;
        }
      });
      const destroyProvider = vi.fn(async () => {
        expect(provisionSettled).toBe(true);
      });
      f.provider.destroy = destroyProvider;
      let environmentId: string;
      if (purpose === "build") {
        ({ environmentId } = await f.service.prepare(f.request));
      } else {
        const intent = await f.service.prepareProjectIntent("development", {
          projectPath: f.projectPath,
          executionMode: "worker-turn",
          setupAuthorized: true,
        });
        ({ environmentId } = support.testState.store.createIntent({
          environmentId: "automatic-reserve",
          provisionOperationId: "automatic-reserve-operation",
          providerId: intent.providerId,
          profileId: "development",
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: intent.preparationKey!,
            demandAtMs: 1_000,
            expiresAtMs: 11_000,
          },
        }));
        f.service.schedulePreparedRefill();
      }
      const signal = await entered.promise;
      if (purpose === "expired reserve") {
        support.testState.nowMs = 11_001;
      }
      const destroyed = f.service.destroyUnattached(environmentId);
      try {
        expect(support.testState.store.get(environmentId)?.destroyRequestedAtMs).toBe(
          support.testState.nowMs,
        );
        expect(signal.aborted).toBe(true);
        expect(destroyProvider).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await destroyed;
      }
      expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
      expect(destroyProvider).toHaveBeenCalledOnce();
    },
  );

  it("deduplicates concurrent fresh builds and fails closed at the global cap", async () => {
    const f = await fixture();
    support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
    const results = await Promise.all([f.service.prepare(f.request), f.service.prepare(f.request)]);
    expect(new Set(results.map((result) => result.environmentId)).size).toBe(1);
    expect(results.filter((result) => result.reused)).toHaveLength(1);
    await requireGit(f.projectPath, ["commit", "--allow-empty", "--quiet", "-m", "next"]);
    await expect(f.service.prepare(f.request)).rejects.toMatchObject({ code: "capacity" });
    expect(support.testState.store.list()).toHaveLength(1);
  });

  it("revalidates caller authority after asynchronous preparation before admission", async () => {
    const f = await fixture();
    let authorized = true;
    f.provider.resolvePreparationTarget = () => {
      authorized = false;
      return { machineClass: "small", platform: "linux", arch: "x64" };
    };
    await expect(
      f.service.prepare(f.request, () => {
        if (!authorized) {
          throw new Error("Caller revoked");
        }
      }),
    ).rejects.toThrow("Caller revoked");
    expect(support.testState.store.list()).toHaveLength(0);
    expect(f.provision).not.toHaveBeenCalled();
  });

  it.each([
    "missing-profile",
    "unsupported",
    "no-timeout",
    "non-git",
    "missing-path",
    "subdirectory",
    "unborn",
  ])("rejects %s before admitting a build", async (scenario) => {
    const f = await fixture();
    let code = "invalid_project";
    if (scenario === "missing-profile") {
      f.request.profileId = "missing";
      code = "profile_not_found";
    } else if (scenario === "unsupported") {
      f.provider.supportsProjectPreparation = () => false;
      code = "invalid_profile";
    } else if (scenario === "no-timeout") {
      f.provider.resolvePreparedIdleTimeoutMs = () => undefined;
      code = "invalid_profile";
    } else if (scenario === "non-git") {
      f.request.projectPath = support.testState.root;
    } else if (scenario === "missing-path") {
      f.request.projectPath = path.join(support.testState.root, "missing");
    } else if (scenario === "subdirectory") {
      f.request.projectPath = path.join(f.projectPath, ".openclaw");
    } else {
      f.request.projectPath = path.join(support.testState.root, "unborn");
      await fs.mkdir(f.request.projectPath);
      await requireGit(f.request.projectPath, ["init", "--quiet"]);
    }
    await expect(f.service.prepare(f.request)).rejects.toMatchObject({ code });
    expect(support.testState.store.list()).toHaveLength(0);
    expect(f.provision).not.toHaveBeenCalled();
  });
});
