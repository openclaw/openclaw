import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  findLiveRegistryWorktreeByOwner,
  insertRegistryWorktree,
  updateRegistryWorktree,
} from "../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { prepareGitHubPublicationAvailability } from "./github-publication-availability.js";

const mocks = vi.hoisted(() => ({ session: vi.fn(), identity: vi.fn() }));
// mock-isolation: Keep session-owner SQL outside the worktree-read measurement.
vi.mock("./session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.session }));
// mock-isolation: Use the synthetic registry without starting managed-worktree services.
vi.mock("../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: (kind: ManagedWorktreeRecord["ownerKind"], id: string) =>
      findLiveRegistryWorktreeByOwner(process.env, kind, id),
  },
}));
// mock-isolation: Control identity preparation without credential discovery.
vi.mock("../agents/github-tool-identity.js", () => ({
  prepareGitHubPublicationIdentity: mocks.identity,
  prepareGitHubPublicationOptionsIdentity: mocks.identity,
  matchesPreparedGitHubPublicationIdentity: () => true,
}));
// mock-isolation: Exclude OAuth credentials and network activity from this reader fixture.
vi.mock("./github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: async () => {},
}));
// mock-isolation: Use synthetic configuration without loading operator configuration.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: Exclude process-wide secret materialization from this reader fixture.
vi.mock("../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: () => undefined,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const session = { sessionKey: "agent:main:publication", sessionId: "session", agentId: "main" };
const worktree: ManagedWorktreeRecord = {
  id: "publication-worktree",
  name: "publication",
  path: "/synthetic/publication",
  repoRoot: "/synthetic/repo",
  repoFingerprint: "synthetic-fingerprint",
  branch: "openclaw/publication",
  baseRef: "main",
  ownerKind: "session",
  ownerId: session.sessionKey,
  createdAt: 1,
  lastActiveAt: 1,
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-worktree-read-"));
  mocks.session.mockReset().mockReturnValue({
    canonicalKey: session.sessionKey,
    agentId: session.agentId,
    entry: {
      sessionId: session.sessionId,
      lifecycleRevision: "lifecycle",
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  });
  mocks.identity.mockReset().mockResolvedValue({ source: "system-configured" });
  insertRegistryWorktree(process.env, worktree);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "prepares publication availability without caller-thread worktree SQL (present: %s)",
  async (present) => {
    if (!present) {
      updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
    }
    const sql = observeMainThreadSql();
    sql.calibrate();
    expect(await prepareGitHubPublicationAvailability(session)).toBe(present);
    sql.expectIdle();
  },
);

it("rejects a worktree retired while publication identity is prepared", async () => {
  mocks.identity.mockImplementationOnce(async () => {
    updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
    return { source: "system-configured" };
  });
  expect(await prepareGitHubPublicationAvailability(session)).toBe(false);
});

it("keeps availability reads on the captured physical store across identity preparation", async () => {
  mocks.identity.mockImplementationOnce(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("publication-other-store-"));
    return { source: "system-configured" };
  });
  expect(await prepareGitHubPublicationAvailability(session)).toBe(true);
});
