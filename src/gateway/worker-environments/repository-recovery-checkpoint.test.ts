import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { prepareRetainedRepositoryCheckpoint } from "./repository-recovery-checkpoint.js";

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  publication: vi.fn(),
  releasePublication: vi.fn(),
  identity: vi.fn(),
  revalidate: vi.fn(async () => {}),
}));
vi.mock("./repository-git-pack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository-git-pack.js")>()),
  prepareRepositoryRecoveryCheckout: mocks.checkout,
}));
vi.mock("../github-repository-publication-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-repository-publication-store.js")>()),
  prepareRepositoryGitHubPublicationBranch: mocks.publication,
}));
vi.mock("./worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-github-binding.js")>()),
  prepareWorkerRepositoryGitHubIdentity: mocks.identity,
}));

const checkpoint = "refs/openclaw/worker-results/accepted";
const repository: SessionRepositoryWorkspaceRecord = {
  workspaceId: "workspace",
  agentId: "main",
  sessionKey: "agent:main:original",
  url: "https://ghe.example.test/example/repository.git",
  requestedRef: "main",
  runSetupScript: false,
  baseCommit: "a".repeat(40),
  baseManifestHash: `sha256:${"b".repeat(64)}`,
  branch: "session/original",
  checkpointRef: checkpoint,
  manifestHash: `sha256:${"c".repeat(64)}`,
  revision: 26,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};
const reached = new Error("canonical authenticated recovery checkout reached");
beforeEach(() => {
  setRuntimeConfigSnapshot({ gateway: { github: { host: "ghe.example.test" } } });
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  mocks.checkout.mockRejectedValue(reached);
  mocks.publication.mockResolvedValue({
    current: () => ({ unsettled: false, head: { pushed_head_commit: "d".repeat(40) } }),
    release: mocks.releasePublication,
  });
  mocks.identity.mockResolvedValue({
    token: "synthetic-selected-recovery-token",
    assertSelected: () => {},
    revalidate: mocks.revalidate,
  });
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("admits the configured Enterprise checkpoint through the existing recovery checkout owner", async () => {
  await expect(
    prepareRetainedRepositoryCheckpoint(
      {
        sessionId: "original",
        agentId: "main",
        sessionKey: repository.sessionKey,
        assertCurrent: () => {},
      },
      { kind: "repository", repository },
    ),
  ).rejects.toBe(reached);
  expect(mocks.publication).toHaveBeenCalledWith(
    { workspaceId: "workspace", branch: "session/original", pushRepository: "example/repository" },
    expect.objectContaining({ agentId: "main", sessionKey: repository.sessionKey }),
  );
  expect(mocks.checkout).toHaveBeenCalledWith(
    expect.objectContaining({
      url: repository.url,
      baseCommit: repository.baseCommit,
      branch: repository.branch,
      requestedRef: "main",
      token: "synthetic-selected-recovery-token",
    }),
  );
  expect(repository.checkpointRef).toBe(checkpoint);
  expect(repository.revision).toBe(26);
  expect(mocks.releasePublication).toHaveBeenCalledOnce();
  expect(mocks.revalidate).toHaveBeenCalledOnce();
});

it("refuses another host before credentials, transport or checkpoint work", async () => {
  await expect(
    prepareRetainedRepositoryCheckpoint(
      {
        sessionId: "original",
        agentId: "main",
        sessionKey: repository.sessionKey,
        assertCurrent: () => {},
      },
      {
        kind: "repository",
        repository: { ...repository, url: "https://github.com/example/repository.git" },
      },
    ),
  ).rejects.toThrow("canonical GitHub repository");
  expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.checkout).not.toHaveBeenCalled();
});
