import { describe, expect, it, vi } from "vitest";
import { createWorkerEnvironmentAccess } from "./environment-access.js";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
} from "./prepared-pool.test-support.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.js";

const admit = vi.hoisted(() =>
  vi.fn<typeof import("./repository-project-admission.js").prepareRepositoryWorkerProjectSource>(),
);
vi.mock("./repository-project-admission.js", () => ({
  prepareRepositoryWorkerProjectSource: admit,
}));

// Exercise the real attached-owner boundary; HTTP/credential selection has its own
// admission proof. Reopening the store must not turn cached content into access.
describe("prepared repository source access", () => {
  const fixture = usePreparedPoolFixture();
  it.each([
    "warm",
    "reopened store",
    "source unavailable",
    "caller revoked",
    "identity replaced",
    "access lost after binding",
  ] as const)("revalidates source access during %s binding", async (scenario) => {
    const project: RepositoryWorkerProjectSnapshot = {
      key: PROJECT_KEY,
      baseCommit: "d".repeat(40),
      source: {
        kind: "repository",
        url: "https://github.com/example/prepared.git",
        repositoryId: "R_prepared_fixture",
        owner: { agent: { agentId: "main", provenance: null }, identity: { source: "anonymous" } },
      },
    };
    const record = fixture.attach(
      fixture.ready(fixture.seed("repository", { repository: project })),
    );
    if (scenario === "reopened store") {
      fixture.reopenStore();
    }
    let callerCurrent = true;
    let identityCurrent = true;
    const revalidate = vi.fn(async () => {
      if (scenario === "access lost after binding") {
        throw new Error("Repository access is no longer available");
      }
    });
    admit.mockReset();
    admit.mockImplementation(async (params) => {
      expect(params.expected).toEqual(project);
      expect(params.namespace).toBe("gateway");
      params.assertCurrent();
      if (scenario === "source unavailable") {
        throw new Error("Repository access is no longer available");
      }
      if (scenario === "caller revoked") {
        callerCurrent = false;
      }
      return {
        project,
        setupRecipe: undefined,
        assertCurrent: () => {
          if (!identityCurrent) {
            throw new Error("Repository identity changed");
          }
        },
        revalidate,
      };
    });
    const prepared = {
      gatewayNamespace: "gateway",
      environmentId: record.environmentId,
      preparationKey: PREPARATION_KEY,
      cacheKey: "9".repeat(64),
      workspaceDir: "/worker/prepared/workspace",
      homeDir: "/worker/prepared/home",
      sourceManifestRef: `sha256:${"a".repeat(64)}`,
      preparedManifestRef: `sha256:${"b".repeat(64)}`,
    };
    const bind = vi.fn(async (request: { assertCurrent: () => void }) => {
      request.assertCurrent();
      if (scenario === "identity replaced") {
        identityCurrent = false;
      }
      return prepared;
    });
    const access = createWorkerEnvironmentAccess({
      store: fixture.store,
      getConfig: () => fixture.config,
      projectNamespace: "gateway",
      bindPreparedWorkspace: bind,
      prepareCurrentBundle: async () => {
        throw new Error("No tunnel should start during source admission");
      },
      now: () => fixture.nowMs,
      identityResolverFor: () => {
        throw new Error("No SSH identity should be acquired during source admission");
      },
      inState: (candidate, ...states) => states.includes(candidate.state),
      isStopping: () => false,
      providerFor: () => fixture.provider,
      resolveProvider: () => fixture.provider,
      serviceError: (_code, message) => new Error(message),
      withLock: async (_id, run) => await run(),
    });
    const result = access.bindPreparedWorkspace({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId: "session:repository",
      sessionKey: "agent:main:session:repository",
      preparationKey: PREPARATION_KEY,
      cacheKey: "9".repeat(64),
      signal: fixture.abort.signal,
      assertCurrent: () => {
        if (!callerCurrent) {
          throw new Error("Dispatch caller retired");
        }
      },
    });
    if (scenario === "warm" || scenario === "reopened store") {
      await expect(result).resolves.toEqual(prepared);
      expect(bind).toHaveBeenCalledOnce();
      expect(revalidate).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toThrow(
        scenario === "caller revoked" ? "Dispatch caller retired" : /Repository (access|identity)/u,
      );
      if (scenario === "source unavailable" || scenario === "caller revoked") {
        expect(bind).not.toHaveBeenCalled();
      } else {
        expect(bind).toHaveBeenCalledOnce();
      }
    }
    expect(admit).toHaveBeenCalledOnce();
    expect(fixture.store.get(record.environmentId)).toEqual(record);
  });
});
