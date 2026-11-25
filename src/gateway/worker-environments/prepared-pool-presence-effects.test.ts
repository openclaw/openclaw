import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  readPreparedPoolPresenceDemand,
  writePreparedPoolPresenceDemand,
} from "./prepared-pool-presence-worker.js";
import {
  createPreparationArtifacts,
  PREPARATION_TARGET,
  usePreparedPoolFixture,
} from "./prepared-pool.test-support.js";
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

afterEach(() => vi.unstubAllGlobals());
afterEach(clearRuntimeConfigSnapshot);
const pool = usePreparedPoolFixture();
type ProvisionOptions = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;

it("uses the real provider lifecycle and authorized private Git transport for presence demand", async () => {
  const git = await gitFixture({ setupRecipe: false });
  vi.stubEnv("OPENCLAW_STATE_DIR", pool.root);
  pool.config.agents = { entries: { main: {} } };
  setRuntimeConfigSnapshot(pool.config);
  const metadata = {
    node_id: git.project.source.repositoryId,
    clone_url: REPOSITORY_URL.replace(/\.git$/u, ""),
    private: true,
  };
  const commit = { sha: git.baseCommit, tree: { sha: git.tree } };
  const node = {
    ...metadata,
    __typename: "Repository",
    object: { ...commit, __typename: "Commit" },
  };
  const responses = [
    [/^\/graphql$/, { data: { node } }],
    [/\/git\/trees\//, { sha: git.tree, truncated: false, tree: [] }],
    [/\/git\/commits\//, commit],
    [/\/commits\//, { sha: commit.sha, commit: { tree: commit.tree } }],
  ] as const;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : input).pathname;
      return Response.json(responses.find(([route]) => route.test(pathname))?.[1] ?? metadata);
    }),
  );
  const upload = vi.fn(git.transport.upload);
  const allocate = vi.fn(async (options: ProvisionOptions) => {
    const result = await options.project!.prepare({ ...git.transport, upload });
    const { workspaceDir } = result.preparedWorkspace!;
    expect(await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")).toBe(
      "pinned private content\n",
    );
    expect(result.cacheHit).toBe(false);
    // Stop after real transfer; do not advertise synthetic node readiness.
    throw new Error("Owned allocation observer completed");
  });
  pool.provider = {
    ...pool.provider,
    requiresNodeEnrollment: true,
    provisionBeforeInstallation: true,
    supportedExecutionModes: ["worker-turn"],
    supportsProjectPreparation: () => true,
    resolvePreparationTarget: () => PREPARATION_TARGET,
    prepareProvision: async (_profile, _operationId, options) => async () => allocate(options!),
  };
  const unexpected = async () => {
    throw new Error("Fixture must not install, bootstrap, or enroll a node");
  };
  pool.service = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    logger: { warn: vi.fn() },
    store: pool.store,
    getConfig: () => pool.config,
    resolveProvider: () => pool.provider,
    projectNamespace: "gateway",
    prepareInstallation: unexpected,
    bootstrapWorker: unexpected,
    prepareNodeEnrollment: unexpected,
    prepareNodeArtifacts: async () => ({
      artifacts: createPreparationArtifacts(),
      assertCurrent: () => {},
    }),
    resolveHumanPresenceDemand: () => ({
      profileId: "development",
      executionMode: "worker-turn",
      repository: { agentId: "main", url: REPOSITORY_URL, ref: "main" },
    }),
    presenceDemandStore: {
      read: readPreparedPoolPresenceDemand,
      write: writePreparedPoolPresenceDemand,
    },
    now: () => pool.nowMs,
  });
  await pool.service.setHumanPresence(true);
  expect(allocate).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledOnce();
  expect(git.requests.length).toBeGreaterThan(0);
  expect(git.requests.every((value) => value === AUTHORIZATION)).toBe(true);
  expect(git.fetches).toMatchObject([{ settled: true }]);
  await assertNoCredentialFiles(git.home);
  expect(git.scripts.join("\n")).not.toContain(TOKEN);
});
