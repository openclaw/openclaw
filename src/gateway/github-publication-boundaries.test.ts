import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.worker.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  BRANCH,
  NEW_HEAD,
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  commands,
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  createTestGitHubPublicationRuntime as createGitHubPublicationRuntime,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistClaimPublicationWorkspace,
  persistPublicationTestSession,
  publicationRequest as sessionRequest,
  publicationWorktree,
  root,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const mocks = githubPublicationTestMocks();
const sessionChanged = { status: "failed", code: "session_changed" };
const workspaceChanged = { status: "failed", code: "workspace_changed" };

function createLocalCoordinator(database = localDatabase()) {
  return createTestGitHubPublicationCoordinator({
    placements: createWorkerSessionPlacementStore({ database }),
  });
}

const localDatabase = () => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
const receipt = (database: ReturnType<typeof localDatabase>, requestId: string) =>
  readGitHubPublicationRequest(database.db, { requestId });
const cloudRequest = (idempotencyKey: string) => ({
  ...sessionRequest(idempotencyKey),
  sessionKey: REQUEST.sessionKey,
  agentId: REQUEST.agentId,
});
const publish = (coordinator: ReturnType<typeof createLocalCoordinator>, key: string) =>
  coordinator.requestForSessionV2(sessionRequest(key));
const worktree = (overrides = {}) => ({
  ...publicationWorktree(),
  ...overrides,
});
function respond(override: (argv: string[]) => ReturnType<typeof commandResult> | undefined) {
  const fallback = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { input?: string }) =>
      override(argv) ?? (await fallback(argv, options)),
  );
}
async function deferIndexRecovery() {
  const { GitHubPublicationRecoveryPendingError } = await vi.importActual<
    typeof import("./github-publication-git-index.js")
  >("./github-publication-git-index.js");
  throw new GitHubPublicationRecoveryPendingError("workspace recovery is pending");
}
function expectNoCommands(...effects: string[]) {
  expect(commands.some((argv) => effects.some((effect) => argv.includes(effect)))).toBe(false);
}

function localClaim(
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
  suffix: string,
) {
  return placements.claimTurn({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    agentId: "main",
    claimId: `claim-during-${suffix}`,
    runId: `run-during-${suffix}`,
    owner: { kind: "local" },
  });
}

async function cloudFixture() {
  const environmentId = "publication-environment";
  await persistClaimPublicationWorkspace();
  const database = localDatabase();
  const placements = createWorkerSessionPlacementStore({ database });
  seedAttachedPlacementEnvironment(database, {
    environmentId,
    sessionId: REQUEST.sessionId,
    ownerEpoch: 2,
  });
  const active = await seedActivePlacement(placements, { environmentId, ownerEpoch: 2 });
  const claim = (runId: string, claimId: string) =>
    placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId,
      runId,
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
  return { database, placements, claim };
}

describe("Gateway GitHub publication boundaries", () => {
  installGitHubPublicationTestHarness();

  it.each(["retained", "missing"] as const)(
    "does not rebind a %s receipt lifecycle when replaying after the real reset",
    async (bindingState) => {
      const session = await persistPublicationTestSession(REQUEST.sessionKey);
      const placements = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      const requested = await placements.startDispatch(REQUEST);
      await placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "Provisioning stopped before allocation",
      });
      const coordinator = createTestGitHubPublicationCoordinator({ placements });
      const input = cloudRequest("deferred-before-reset");
      const accepted = await coordinator.requestForSessionV2(input);
      expect(accepted.status).toBe("requested");
      const binding = { publicationKind: "shared" as const, requestId: accepted.requestId };
      const originalLifecycle = readGitHubPublicationSessionLifecycle(
        binding,
        openOpenClawStateDatabase().db,
      );
      expect(originalLifecycle).toEqual({
        lifecycle_revision: session.read().lifecycleRevision,
        requester_authority_json: expect.any(String),
      });
      if (bindingState === "missing") {
        openOpenClawStateDatabase()
          .db.prepare(
            "DELETE FROM github_publication_session_lifecycles WHERE publication_kind = 'shared' AND request_id = ?",
          )
          .run(accepted.requestId);
      }
      await session.reset(placements);
      const replay = await coordinator.requestForSessionV2(input);
      expect(replay).toMatchObject(sessionChanged);
      expect(
        readGitHubPublicationSessionLifecycle(binding, openOpenClawStateDatabase().db),
      ).toEqual(bindingState === "retained" ? originalLifecycle : undefined);
      await coordinator.resumeSessionRequests();
      expect(await coordinator.readAsync(accepted.requestId)).toMatchObject(sessionChanged);
      expectNoCommands("push", "POST");
    },
  );

  it.each(["local", "worktree"] as const)(
    "rejects unsafe %s transport configuration before publication",
    async (scope) => {
      respond((argv) => {
        if (
          scope === "worktree" &&
          argv.join(" ") === "git config --local --includes --bool --get extensions.worktreeConfig"
        ) {
          return commandResult("true\n");
        }
        if (argv.includes("--includes") && argv.includes("--get-regexp")) {
          return argv.includes(`--${scope}`)
            ? commandResult("credential.helper ./steal-profile\n")
            : commandResult("", 1);
        }
        return undefined;
      });
      const coordinator = createLocalCoordinator();
      await expect(publish(coordinator, `unsafe-${scope}-config`)).rejects.toThrow(
        "unsupported Git transport configuration",
      );
      expectNoCommands("push");
    },
  );

  it("rejects the pull request base branch before any repository mutation", async () => {
    mocks.findWorktree.mockReturnValue(worktree({ branch: "main" }));
    mocks.loadSession.mockReturnValue({
      canonicalKey: SESSION_KEY,
      agentId: "main",
      storePath: "/state/sessions.json",
      entry: {
        sessionId: SESSION_ID,
        worktree: { id: "worktree-1", branch: "main", repoRoot: "/repo" },
      },
    });
    await persistPublicationTestSession();
    const coordinator = createLocalCoordinator();

    await expect(publish(coordinator, "base-branch")).resolves.toMatchObject(workspaceChanged);
    expectNoCommands("commit-tree", "push");
  });

  it("publishes a feature worktree whose base metadata is HEAD", async () => {
    mocks.findWorktree.mockImplementation((_ownerKind, ownerId: string) =>
      worktree({ baseRef: "HEAD", ownerId }),
    );
    const coordinator = createLocalCoordinator();

    await expect(publish(coordinator, "head-base-metadata")).resolves.toMatchObject({
      status: "published",
      branch: BRANCH,
    });
    expect(commands.some((argv) => argv.join(" ").includes("git/ref/heads/main"))).toBe(true);
  });

  it("rejects a local turn that starts and finishes during snapshot capture", async () => {
    const database = localDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const fallback = mocks.runCommand.getMockImplementation()!;
    let raced = false;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (!raced && argv.includes("add")) {
        raced = true;
        const claim = await localClaim(placements, "snapshot");
        await placements.releaseTurn(claim);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    await expect(publish(coordinator, "local-turn-during-snapshot")).rejects.toThrow(
      "session authority changed during snapshot",
    );
    expectNoCommands("commit-tree", "push");
  });

  it("requeues a publication when execution loses live session authority", async () => {
    const database = localDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    let competingClaim: Awaited<ReturnType<typeof placements.claimTurn>> | undefined;
    mocks.resolveRepository.mockImplementationOnce(async () => {
      competingClaim = await localClaim(placements, "publication");
      return {
        checkoutRoot: "/repo/worktree",
        repoRoot: "/repo",
        originUrl: "git@github.com:openclaw/openclaw.git",
        fingerprint: "fingerprint-1",
      };
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    const queued = await publish(coordinator, "lost-publication-authority");

    expect(queued).toMatchObject({ status: "requested" });
    expectNoCommands("commit-tree", "push");
    expect(competingClaim).toBeDefined();
    await placements.releaseTurn(competingClaim!);

    await coordinator.resumeSessionRequests();

    expect(await coordinator.readAsync(queued.requestId)).toMatchObject({ status: "published" });
  });

  it.each([
    { boundary: "update-ref", status: "failed", effects: [] },
    { boundary: "push", status: "failed", effects: ["push"] },
    { boundary: "pull_request", status: "published", effects: ["push", "pull_request"] },
  ] as const)(
    "settles accepted shared publication work when authority closes after $boundary",
    async ({ boundary, status, effects }) => {
      const workspace = await createRealPublicationWorkspace();
      const database = openOpenClawStateDatabase();
      const coordinator = createLocalCoordinator(database);
      const transport = mocks.runCommand.getMockImplementation()!;
      let current = true;
      mocks.runCommand.mockImplementation(async (argv: string[], options) => {
        const result = await transport(argv, options);
        if (
          result.code === 0 &&
          (boundary === "pull_request"
            ? argv.includes("POST") && argv.includes("repos/openclaw/openclaw/pulls")
            : argv[0] === "git" && argv.includes(boundary))
        ) {
          current = false;
        }
        return result;
      });
      const result = await coordinator.requestForSessionV2({
        ...sessionRequest(`shared-authority-after-${boundary}`),
        assertCurrent: () => {
          if (!current) {
            throw new GitHubPublicationRequesterUnavailableError();
          }
        },
      });
      expect(result.status).toBe(status);
      expect(await coordinator.readAsync(result.requestId)).toEqual(result);
      expect(current).toBe(false);
      await coordinator.resumeSessionRequests();
      expect(await coordinator.readAsync(result.requestId)).toEqual(result);
      const headCommit = await workspace.git("rev-parse", "HEAD");
      expect(await workspace.git("show", "HEAD:artifact.txt")).toBe("accepted");
      expect(await workspace.git("status", "--porcelain")).toBe("");
      expect(
        (await fs.readdir(path.join(workspace.cwd, ".git"))).filter(
          (entry) => entry === "index.lock" || entry.startsWith("index.openclaw-"),
        ),
      ).toEqual([]);
      expect(receipt(database, result.requestId)).toMatchObject({
        status,
        head_commit: headCommit,
        pull_request_url:
          boundary === "pull_request" ? "https://github.com/openclaw/openclaw/pull/125200" : null,
      });
      expect(workspace.effects).toEqual(effects);
    },
  );

  it.each(["lookup", "fetch", "ancestry"] as const)(
    "reports unavailable without mutation when base %s verification fails",
    async (fault) => {
      respond((argv) =>
        (fault === "lookup" && argv.some((arg) => arg.includes("/git/ref/heads/main"))) ||
        (fault === "fetch" && argv.includes("fetch")) ||
        (fault === "ancestry" && argv[0] === "git" && argv[1] === "merge-base")
          ? commandResult("", 128)
          : undefined,
      );
      const coordinator = createLocalCoordinator();

      const result = await publish(coordinator, `unavailable-base-${fault}`);
      expect(result).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining("base or its Git history could not be verified"),
      });
      expect(await coordinator.readAsync(result.requestId)).toEqual(result);
      expectNoCommands("commit-tree", "update-ref", "push", "POST");
    },
  );

  it.each([
    {
      label: "foreign owner",
      response: JSON.stringify([
        {
          url: "https://github.com/openclaw/openclaw/pull/foreign",
          userId: 99,
          state: "open",
          body: "",
          headSha: "b".repeat(40),
          headRef: BRANCH,
          baseRef: "main",
        },
      ]),
    },
    { label: "invalid JSON", response: "truncated" },
    { label: "non-array JSON", response: "{}" },
    { label: "invalid candidate", response: "[{}]" },
  ])("fails closed for $label in pull request ownership", async ({ label, response }) => {
    respond((argv) =>
      argv.join(" ").includes(" repos/openclaw/openclaw/pulls ")
        ? commandResult(response)
        : undefined,
    );
    const coordinator = createLocalCoordinator();
    await expect(publish(coordinator, `invalid-pr-ownership-${label}`)).resolves.toMatchObject({
      status: "failed",
      code: "github_rejected",
    });
    expectNoCommands("commit-tree", "push");
  });

  it("keeps an incomplete Git transaction retryable until index recovery completes", async () => {
    const database = localDatabase();
    const coordinator = createLocalCoordinator(database);
    mocks.updateIndex.mockImplementationOnce(deferIndexRecovery);
    const request = sessionRequest("recover-index-transaction");
    await expect(coordinator.requestForSessionV2(request)).rejects.toThrow(
      "workspace recovery is pending",
    );
    expect(
      readGitHubPublicationRequest(database.db, {
        sessionId: SESSION_ID,
        idempotencyKey: request.idempotencyKey,
      }),
    ).toMatchObject({ status: "publishing" });
    await expect(coordinator.requestForSessionV2(request)).resolves.toMatchObject({
      status: "published",
    });
  });

  it("continues settling other receipts when one workspace still needs Git recovery", async () => {
    const database = localDatabase();
    const coordinator = createLocalCoordinator(database);
    seedLocalPublication(database, { requestId: "blocked", status: "publishing" });
    seedLocalPublication(database, { requestId: "following", status: "requested" });
    seedLocalPublication(database, {
      requestId: "stale",
      status: "publishing",
      repositoryFingerprint: "replaced-fingerprint",
    });
    database.db
      .prepare("UPDATE github_publication_requests SET created_at_ms = ? WHERE request_id = ?")
      .run(1_001, "following");
    database.db
      .prepare("UPDATE github_publication_requests SET created_at_ms = ? WHERE request_id = ?")
      .run(1_002, "stale");
    const otherSession = "agent:main:other-publication";
    const otherWorktree = {
      ...mocks.findWorktree("session", otherSession),
      id: "worktree-2",
      path: "/repo/other-worktree",
    };
    await insertRegistryWorktree(process.env, {
      ...otherWorktree,
      name: "other",
      createdAt: 1,
      lastActiveAt: 1,
    });
    database.db
      .prepare(
        "UPDATE github_publication_requests SET worktree_id = ?, session_id = ?, session_key = ? WHERE request_id = ?",
      )
      .run(otherWorktree.id, "session-other", otherSession, "stale");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: otherSession },
      {
        ...mocks.loadSession(otherSession).entry,
        sessionId: "session-other",
        worktree: { id: otherWorktree.id, branch: BRANCH, repoRoot: "/repo" },
      },
    );
    mocks.persistedSessionKeys.add(otherSession);
    const findWorktree = mocks.findWorktree.getMockImplementation()!;
    mocks.findWorktree.mockImplementation((kind: string, key: string) =>
      key === otherSession ? otherWorktree : findWorktree(kind, key),
    );
    mocks.updateIndex.mockImplementationOnce(deferIndexRecovery);
    await expect(coordinator.resumeSessionRequests()).rejects.toThrow(
      "workspace recovery is pending",
    );
    expect(await coordinator.readAsync("blocked")).toMatchObject({ status: "publishing" });
    expect(await coordinator.readAsync("following")).toMatchObject({ status: "requested" });
    expect(await coordinator.readAsync("stale")).toMatchObject(workspaceChanged);
    expectNoCommands("push", "POST");
  });

  it.each([
    { fault: "credential", attempt: "fresh" },
    { fault: "credential", attempt: "historical" },
    { fault: "unsafe-config", attempt: "fresh" },
    { fault: "unsafe-config", attempt: "historical" },
  ] as const)("preserves $attempt outcomes during $fault recovery", async ({ fault, attempt }) => {
    const database = localDatabase();
    const coordinator = createLocalCoordinator(database);
    const requestId = `publication-${fault}`;
    seedLocalPublication(database, {
      requestId,
      status: "requested",
      headCommit: attempt === "fresh" ? null : NEW_HEAD,
    });
    if (fault === "credential") {
      const config = { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } };
      mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
      const { prepareGitHubPublicationIdentity } = await vi.importActual<
        typeof import("../agents/github-tool-identity.js")
      >("../agents/github-tool-identity.js");
      mocks.prepareIdentity.mockImplementation(prepareGitHubPublicationIdentity);
    } else {
      mocks.findWorktreeById.mockReturnValue(worktree());
      respond((argv) =>
        argv.includes("--local") && argv.includes("--get-regexp")
          ? commandResult("core.fsmonitor ./untrusted-monitor\n")
          : undefined,
      );
    }
    const resumed = coordinator.resumeSessionRequests();
    if (attempt === "historical") {
      await expect(resumed).rejects.toThrow("GitHub publication is unconfirmed");
      expect(await coordinator.readAsync(requestId)).toMatchObject({ status: "publishing" });
    } else {
      await resumed;
      expect(await coordinator.readAsync(requestId)).toMatchObject({
        status: "failed",
        code: fault === "credential" ? "identity_unavailable" : "workspace_changed",
        ...(fault === "credential" ? { nextAction: expect.stringContaining("Reconnect") } : {}),
      });
    }
    if (fault === "credential") {
      expectNoCommands("push", "POST");
    } else {
      expect(commands.some((argv) => argv.join(" ") === "git rev-parse --git-path index")).toBe(
        false,
      );
    }
  });

  it("terminalizes local recovery when the managed worktree fingerprint changed", async () => {
    const database = localDatabase();
    const requestId = "publication-stale-worktree";
    seedLocalPublication(database, {
      requestId,
      status: "requested",
      repositoryFingerprint: "replaced-fingerprint",
    });
    await closeStateDatabaseForTest();
    const reopened = localDatabase();
    const resumed = createLocalCoordinator(reopened);

    await resumed.resumeSessionRequests();

    expect(await resumed.readAsync(requestId)).toEqual({
      publisher: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
      requestId,
      status: "failed",
      code: "workspace_changed",
      message: "GitHub publication failed.",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    });
    expect(commands).toEqual([]);
  });

  it("validates the live session owner before recovery can touch Git state", async () => {
    const database = localDatabase();
    const coordinator = createLocalCoordinator(database);
    const requestId = "publication-stale-session-owner";
    seedLocalPublication(database, { requestId, status: "requested" });
    mocks.findWorktreeById.mockReturnValue(worktree());
    mocks.findWorktree.mockReturnValue(worktree({ ownerId: "agent:main:dashboard:replacement" }));

    await coordinator.resumeSessionRequests();

    expect(await coordinator.readAsync(requestId)).toMatchObject(sessionChanged);
    expect(commands).toEqual([]);
  });

  it.each([
    { label: "no live claim", claimRunId: undefined, expectedRunId: undefined },
    { label: "a mismatched run identity", claimRunId: "run-active", expectedRunId: "run-other" },
    { label: "its own active turn", claimRunId: "run-active", expectedRunId: "run-active" },
  ])("queues a cloud session publication with $label", async ({ claimRunId, expectedRunId }) => {
    const { database, placements, claim: claimTurn } = await cloudFixture();
    const claim = claimRunId ? await claimTurn(claimRunId, "claim-active") : undefined;
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    const result = await coordinator.requestForSessionV2({
      ...cloudRequest("deferred-cloud-request"),
      ...(expectedRunId ? { expectedRunId } : {}),
    });
    const acceptedClaim = claim?.runId === expectedRunId ? claim : undefined;

    expect(result).toMatchObject({ status: "requested" });
    expect(receipt(database, result.requestId)).toMatchObject({
      claim_id: acceptedClaim?.claimId ?? null,
      run_id: acceptedClaim?.runId ?? null,
      environment_id: acceptedClaim?.owner.environmentId ?? null,
      owner_epoch: acceptedClaim?.owner.ownerEpoch ?? null,
      placement_generation: acceptedClaim?.placementGeneration ?? null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
    });
    expect(commands).toEqual([]);
  });

  it("publishes deferred session requests alongside an accepted turn claim", async () => {
    const { placements, claim: claimTurn } = await cloudFixture();
    const coordinator = createTestGitHubPublicationCoordinator({ placements });
    const deferred = await coordinator.requestForSessionV2(
      cloudRequest("accepted-deferred-session"),
    );
    const claim = await claimTurn("run-accepted-deferred", "claim-accepted-deferred");
    const claimed = await coordinator.requestForClaimV2({
      claim,
      ...cloudRequest("accepted-claim-session"),
    });
    await placements.markWorkspaceResultPending(claim);
    await coordinator.prepareClaimWorkspace(claim);
    await placements.acceptWorkspaceResult(claim);

    await expect(coordinator.processClaim(claim)).resolves.toEqual([
      expect.objectContaining({ requestId: claimed.requestId, status: "published" }),
      expect.objectContaining({ requestId: deferred.requestId, status: "published" }),
    ]);
  });

  it.each(["local", "worker"] as const)(
    "keeps a live %s request until its turn ends, then publishes it when quiescent",
    async (owner) => {
      const fixture = owner === "worker" ? await cloudFixture() : undefined;
      const database = fixture?.database ?? localDatabase();
      const placements = fixture?.placements ?? createWorkerSessionPlacementStore({ database });
      const claim = fixture
        ? await fixture.claim("run-orphan", "claim-orphan")
        : await localClaim(placements, "orphan");
      const coordinator = createTestGitHubPublicationCoordinator({ placements });
      const accepted = await coordinator.requestForClaimV2({
        claim,
        ...(owner === "worker" ? cloudRequest("publish-orphan") : sessionRequest("publish-orphan")),
      });
      await coordinator.deferOrphanedRequestsAsync();
      expect(receipt(database, accepted.requestId)?.claim_id).toBe(claim.claimId);
      await placements.releaseTurn(claim);

      expect(await coordinator.deferOrphanedRequestsAsync()).toBeUndefined();
      expect(receipt(database, accepted.requestId)?.claim_id).toBeNull();

      expect(await coordinator.readAsync(accepted.requestId)).toMatchObject({
        status: "requested",
      });
      expect(await coordinator.listUnreportedResultsAsync()).toEqual([]);
      expect(commands).toEqual([]);

      await coordinator.resumeSessionRequests();

      expect(await coordinator.readAsync(accepted.requestId)).toMatchObject({
        status: "published",
      });
      expect(await coordinator.listUnreportedResultsAsync()).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ status: "published" }) }),
      ]);
    },
  );

  it("defers snapshot preparation failures without blocking workspace acceptance", async () => {
    const { database, placements, claim: claimTurn } = await cloudFixture();
    const claim = await claimTurn("run-snapshot-failure", "claim-snapshot-failure");
    const runtime = createGitHubPublicationRuntime({
      placements,
      loadSessionRuntime: async () => {
        throw new Error("not used");
      },
      warn: () => undefined,
    });
    const requested = await runtime.coordinator.requestForClaimV2({
      claim,
      ...cloudRequest("snapshot-failure"),
    });
    await placements.markWorkspaceResultPending(claim);
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
      argv.includes("--get-regexp")
        ? commandResult("filter.attacker.clean ./run-attacker\n")
        : await fallback(argv, options),
    );

    await expect(runtime.prepareAcceptedWorkspacePublication(claim)).resolves.toBeUndefined();
    expect(receipt(database, requested.requestId)).toMatchObject({
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      gateway_instance_id: null,
    });
    await expect(placements.acceptWorkspaceResult(claim)).resolves.toBeUndefined();
    await runtime.coordinator.resumeSessionRequests();
    expect(await runtime.coordinator.readAsync(requested.requestId)).toMatchObject({
      status: "requested",
    });
    mocks.runCommand.mockImplementation(fallback);
    await placements.completeWorkspaceResultAndReleaseTurn(claim);

    await runtime.coordinator.resumeSessionRequests();

    expect(await runtime.coordinator.readAsync(requested.requestId)).toMatchObject({
      status: "published",
    });
  });
});
