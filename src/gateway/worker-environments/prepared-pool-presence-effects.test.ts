import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import {
  AUTHORIZATION,
  TOKEN,
  URL as REPOSITORY_URL,
  assertNoCredentialFiles,
  fixture as gitFixture,
} from "./repository-git-pack.test-support.js";
import { createWorkerEnvironmentService } from "./service.js";

vi.mock("../../agents/github-tool-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/github-tool-identity.js")>()),
  prepareGitHubReadIdentity: async ({ assertActive }: { assertActive: () => void }) => {
    assertActive();
    return {
      token: TOKEN,
      selection: { source: "system-detected", accountId: 123 },
      cacheScope: "synthetic-private-repository",
      assertSelected: assertActive,
      revalidate: async () => assertActive(),
    };
  },
}));

describe("presence demand at private preparation effects", () => {
  const pool = usePreparedPoolFixture();

  it("uses the real provider lifecycle and authorized private Git transport", async () => {
    const git = await gitFixture({ setupRecipe: false });
    vi.stubEnv("OPENCLAW_STATE_DIR", pool.root);
    pool.config.agents = { entries: { main: {} } };
    pool.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
    pool.developmentProfile.readyWorkers = 1;
    setRuntimeConfigSnapshot(pool.config);
    const metadata = {
      node_id: git.project.source.repositoryId,
      clone_url: REPOSITORY_URL.replace(/\.git$/u, ""),
      private: true,
      default_branch: "main",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const pathname = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        ).pathname;
        if (pathname === "/graphql") {
          return Response.json({
            data: {
              node: {
                ...metadata,
                __typename: "Repository",
                object: { __typename: "Commit", sha: git.baseCommit, tree: { sha: git.tree } },
              },
            },
          });
        }
        if (pathname.includes("/git/trees/")) {
          return Response.json({ sha: git.tree, truncated: false, tree: [] });
        }
        if (pathname.includes("/git/commits/")) {
          return Response.json({ sha: git.baseCommit, tree: { sha: git.tree } });
        }
        if (pathname.includes("/commits/")) {
          return Response.json({ sha: git.baseCommit, commit: { tree: { sha: git.tree } } });
        }
        return Response.json(metadata);
      }),
    );
    const upload = vi.fn(git.transport.upload);
    const allocate = vi.fn(
      async (options: NonNullable<Parameters<WorkerProvider["provision"]>[2]>) => {
        const result = await options.project!.prepare({ ...git.transport, upload });
        expect(
          await fs.readFile(path.join(result.preparedWorkspace!.workspaceDir, "input.txt"), "utf8"),
        ).toBe("pinned private content\n");
        expect(result.cacheHit).toBe(false);
        // The provider contract reaches real transfer before this owned observer
        // declines allocation; no synthetic node readiness is advertised.
        throw new Error("Owned allocation observer completed");
      },
    );
    pool.provider = {
      ...pool.provider,
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportedExecutionModes: ["worker-turn"],
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({
        machineClass: "standard",
        platform: "linux",
        arch: "x64",
      }),
      prepareProvision: async (_profile, _operationId, options) => {
        return async () => allocate(options!);
      },
    };
    const warnings: string[] = [];
    const diagnostics = () =>
      JSON.stringify({
        warnings,
        reserves: pool.reserves().map(({ state, lastError, destroyRequestedAtMs }) => ({
          state,
          lastError,
          destroyRequestedAtMs,
        })),
      });
    let demand: PreparedPoolPresenceDemand | undefined;
    pool.service = createWorkerEnvironmentService({
      scheduler: createTestGatewayScheduler(),
      logger: { warn: (message) => warnings.push(message) },
      store: pool.store,
      getConfig: () => pool.config,
      resolveProvider: () => pool.provider,
      projectNamespace: "gateway",
      prepareInstallation: async () => {
        throw new Error("Fixture must not install a node");
      },
      bootstrapWorker: async () => {
        throw new Error("Fixture must not bootstrap a node");
      },
      prepareNodeEnrollment: async () => {
        throw new Error("Fixture must not enroll a node");
      },
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: "e".repeat(64),
          enabledPluginIds: [],
          workerBundleHash: "c".repeat(64),
          workerArchiveSha256: "f".repeat(64),
          openclawVersion: "2026.8.1",
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }),
      resolveHumanPresenceDemand: () => ({
        profileId: "development",
        executionMode: "worker-turn",
        repository: { agentId: "main", url: REPOSITORY_URL, ref: "main" },
      }),
      presenceDemandStore: {
        read: async () => demand,
        write: async (value, assertCurrent) => {
          assertCurrent();
          demand = value ?? undefined;
          return demand;
        },
      },
      now: () => pool.nowMs,
    });
    const preparation = pool.service.setHumanPresence(true);
    try {
      await preparation;
      expect(allocate, diagnostics()).toHaveBeenCalledOnce();
      expect(upload).toHaveBeenCalledOnce();
      expect(git.requests.length).toBeGreaterThan(0);
      expect(git.requests.every((value) => value === AUTHORIZATION)).toBe(true);
      expect(git.fetches).toHaveLength(1);
      expect(git.fetches[0]?.settled).toBe(true);
      await assertNoCredentialFiles(git.home);
      expect(git.scripts.join("\n")).not.toContain(TOKEN);
    } finally {
      await preparation;
      await pool.service.stop();
      clearRuntimeConfigSnapshot();
      vi.unstubAllGlobals();
    }
  });
});
