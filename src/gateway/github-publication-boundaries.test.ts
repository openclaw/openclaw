import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  GitHubPublicationRequesterUnavailableError,
  resolveGitHubPublicationFailure,
} from "./github-publication-failure.js";
import {
  BASE_HEAD,
  BRANCH,
  NEW_HEAD,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  commandResult,
  commands,
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  createTestGitHubPublicationRuntime as createGitHubPublicationRuntime,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
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
      placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "Provisioning stopped before allocation",
      });
      const coordinator = createTestGitHubPublicationCoordinator({ placements });
      const input = {
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        idempotencyKey: "deferred-before-reset",
      };
      const accepted = await coordinator.requestForSession(input);
      expect(accepted.status).toBe("requested");
      const binding = { publicationKind: "shared" as const, requestId: accepted.requestId };
      const originalLifecycle = readGitHubPublicationSessionLifecycle(binding);
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
      const replay = await coordinator.requestForSession(input);
      expect(replay).toMatchObject({ status: "failed", code: "session_changed" });
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(
        bindingState === "retained" ? originalLifecycle : undefined,
      );
      await coordinator.resumeSessionRequests();
      expect(coordinator.read(accepted.requestId)).toMatchObject({
        status: "failed",
        code: "session_changed",
      });
      expect(commands.some((argv) => argv.includes("push") || argv.includes("POST"))).toBe(false);
    },
  );

  it.each([
    ["URL rewrite", "url.https://attacker.invalid/.insteadof https://github.com/"],
    ["HTTP proxy", "http.proxy https://attacker.invalid/"],
    ["push expansion", "push.followtags true"],
    ["worktree redirect", "core.worktree /tmp/other-checkout"],
    ["alternate refs command", "core.alternaterefscommand ./steal-profile"],
    ["askpass command", "core.askpass ./steal-profile"],
    ["fsmonitor command", "core.fsmonitor ./steal-profile"],
    ["credential helper", "credential.helper ./steal-profile"],
    ["remote upload-pack", "remote.origin.uploadpack ./steal-profile"],
    ["upload-pack hook", "uploadpack.packobjectshook ./steal-profile"],
  ])("rejects repository-local %s before snapshot or transport", async (label, configLine) => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("--includes") && argv.includes("--get-regexp")) {
        return commandResult(`${configLine}\n`);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: `unsafe-${label}`,
      }),
    ).rejects.toThrow("unsupported Git transport configuration");
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("rejects unsafe worktree-scoped transport config when the scope is enabled", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command === "git config --local --includes --bool --get extensions.worktreeConfig") {
        return commandResult("true\n");
      }
      if (argv.includes("--get-regexp")) {
        return argv.includes("--worktree")
          ? commandResult("credential.helper ./steal-profile\n")
          : commandResult("", 1);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "unsafe-worktree-config",
      }),
    ).rejects.toThrow("unsupported Git transport configuration");
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("explains how to remove unsupported Git transport configuration", () => {
    expect(
      resolveGitHubPublicationFailure(
        new Error("GitHub publication workspace has unsupported Git transport configuration."),
      ),
    ).toEqual({
      code: "workspace_changed",
      nextAction:
        "Remove the unsupported Git transport or replacement configuration from the session worktree, then retry.",
    });
  });

  it("rejects the pull request base branch before any repository mutation", async () => {
    mocks.findWorktree.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: "main",
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
    });
    mocks.loadSession.mockReturnValue({
      canonicalKey: SESSION_KEY,
      agentId: "main",
      storePath: "/state/sessions.json",
      entry: {
        sessionId: SESSION_ID,
        worktree: { id: "worktree-1", branch: "main", repoRoot: "/repo" },
      },
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "base-branch",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("publishes a feature worktree whose base metadata is HEAD", async () => {
    mocks.findWorktree.mockImplementation((_ownerKind, ownerId: string) => ({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId,
    }));
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "head-base-metadata",
      }),
    ).resolves.toMatchObject({ status: "published", branch: BRANCH });
    expect(commands.some((argv) => argv.join(" ").includes("git/ref/heads/main"))).toBe(true);
  });

  it("rejects an accepted tree identical to the base before creating a marker commit", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.join(" ") === `git rev-parse ${BASE_HEAD}^{tree}`) {
        return commandResult(`${WORKSPACE_TREE}\n`);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "no-tree-change",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "no_changes" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("rejects a local turn that starts and finishes during snapshot capture", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const fallback = mocks.runCommand.getMockImplementation()!;
    let raced = false;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (!raced && argv.includes("add")) {
        raced = true;
        const claim = await placements.claimTurn({
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          claimId: "claim-during-snapshot",
          runId: "run-during-snapshot",
          owner: { kind: "local" },
        });
        await placements.releaseTurn(claim);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "local-turn-during-snapshot",
      }),
    ).rejects.toThrow("session authority changed during snapshot");
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("requeues a publication when execution loses live session authority", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    let competingClaim: Awaited<ReturnType<typeof placements.claimTurn>> | undefined;
    mocks.resolveRepository.mockImplementationOnce(async () => {
      competingClaim = await placements.claimTurn({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        claimId: "claim-during-publication",
        runId: "run-during-publication",
        owner: { kind: "local" },
      });
      return {
        checkoutRoot: "/repo/worktree",
        repoRoot: "/repo",
        originUrl: "git@github.com:openclaw/openclaw.git",
        fingerprint: "fingerprint-1",
      };
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    const queued = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "lost-publication-authority",
    });

    expect(queued).toMatchObject({ status: "requested" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
    expect(competingClaim).toBeDefined();
    await placements.releaseTurn(competingClaim!);

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(queued.requestId)).toMatchObject({ status: "published" });
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
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
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
      const idempotencyKey = `shared-authority-after-${boundary}`;
      const result = await coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey,
        assertCurrent: () => {
          if (!current) {
            throw new GitHubPublicationRequesterUnavailableError();
          }
        },
      });
      expect(result.status).toBe(status);
      expect(coordinator.read(result.requestId)).toEqual(result);
      expect(current).toBe(false);
      await coordinator.resumeSessionRequests();
      expect(coordinator.read(result.requestId)).toEqual(result);
      const headCommit = await workspace.git("rev-parse", "HEAD");
      expect(await workspace.git("show", "HEAD:artifact.txt")).toBe("accepted");
      expect(await workspace.git("status", "--porcelain")).toBe("");
      expect(
        (await fs.readdir(path.join(workspace.cwd, ".git"))).filter(
          (entry) => entry === "index.lock" || entry.startsWith("index.openclaw-"),
        ),
      ).toEqual([]);
      expect(
        database.db
          .prepare(
            "SELECT status, head_commit, pull_request_url FROM github_publication_requests WHERE idempotency_key = ?",
          )
          .get(idempotencyKey),
      ).toEqual({
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
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (
          (fault === "lookup" && argv.some((arg) => arg.includes("/git/ref/heads/main"))) ||
          (fault === "fetch" && argv.includes("fetch")) ||
          (fault === "ancestry" && argv[0] === "git" && argv[1] === "merge-base")
        ) {
          return commandResult("", 128);
        }
        return await fallback(argv, options);
      });
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({
          database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
        }),
      });

      const result = await coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: `unavailable-base-${fault}`,
      });
      expect(result).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining("base or its Git history could not be verified"),
      });
      expect(coordinator.read(result.requestId)).toEqual(result);
      expect(
        commands.some(
          (argv) =>
            argv.includes("commit-tree") ||
            argv.includes("update-ref") ||
            argv.includes("push") ||
            argv.includes("POST"),
        ),
      ).toBe(false);
    },
  );

  it("refuses a matching pull request owned by another GitHub account", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const command = argv.join(" ");
      if (command.includes(" repos/openclaw/openclaw/pulls ")) {
        return commandResult(
          JSON.stringify([
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
        );
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "foreign-pr",
      }),
    ).resolves.toMatchObject({ status: "failed", code: "github_rejected" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it.each([
    { label: "invalid JSON", response: "truncated" },
    { label: "non-array JSON", response: "{}" },
    { label: "invalid candidate", response: "[{}]" },
  ])("fails closed for $label in pull request ownership", async ({ label, response }) => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.join(" ").includes(" repos/openclaw/openclaw/pulls ")) {
        return commandResult(response);
      }
      return await fallback(argv, options);
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: `invalid-pr-ownership-${label}`,
      }),
    ).resolves.toMatchObject({ status: "failed", code: "github_rejected" });
    expect(commands.some((argv) => argv.includes("commit-tree") || argv.includes("push"))).toBe(
      false,
    );
  });

  it("creates an attributed marker commit when all changes were already committed", async () => {
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    await expect(
      coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "committed-work",
        title: "Publish committed work",
      }),
    ).resolves.toMatchObject({ status: "published", branch: BRANCH });
    expect(commands.filter((argv) => argv.includes("commit-tree"))).toHaveLength(1);
    for (const [, options] of mocks.runCommand.mock.calls) {
      expect(options?.env).toMatchObject({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: os.devNull,
      });
    }
  });

  it("keeps an incomplete Git transaction retryable until index recovery completes", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    mocks.updateIndex.mockImplementationOnce(async () => {
      const { GitHubPublicationRecoveryPendingError } = await vi.importActual<
        typeof import("./github-publication-git-index.js")
      >("./github-publication-git-index.js");
      throw new GitHubPublicationRecoveryPendingError("workspace recovery is pending");
    });
    const request = {
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "recover-index-transaction",
    };

    await expect(coordinator.requestForSession(request)).rejects.toThrow(
      "workspace recovery is pending",
    );
    expect(
      database.db
        .prepare("SELECT status FROM github_publication_requests WHERE idempotency_key = ?")
        .get(request.idempotencyKey),
    ).toEqual({ status: "publishing" });
    await expect(coordinator.requestForSession(request)).resolves.toMatchObject({
      status: "published",
    });
  });

  it("continues settling other receipts when one workspace still needs Git recovery", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    coordinator.read("create-schema");
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
    insertRegistryWorktree(process.env, {
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
    const loadSession = mocks.loadSession.getMockImplementation()!;
    mocks.loadSession.mockImplementation((key: string) => {
      const loaded = loadSession(key);
      return key === otherSession
        ? {
            ...loaded,
            entry: {
              ...loaded.entry,
              sessionId: "session-other",
              worktree: { id: otherWorktree.id, branch: BRANCH, repoRoot: "/repo" },
            },
          }
        : loaded;
    });
    const findWorktree = mocks.findWorktree.getMockImplementation()!;
    mocks.findWorktree.mockImplementation((kind: string, key: string) =>
      key === otherSession ? otherWorktree : findWorktree(kind, key),
    );
    mocks.updateIndex.mockImplementationOnce(async () => {
      const { GitHubPublicationRecoveryPendingError } = await vi.importActual<
        typeof import("./github-publication-git-index.js")
      >("./github-publication-git-index.js");
      throw new GitHubPublicationRecoveryPendingError("workspace recovery is pending");
    });
    await expect(coordinator.resumeSessionRequests()).rejects.toThrow(
      "workspace recovery is pending",
    );
    expect(coordinator.read("blocked")).toMatchObject({ status: "publishing" });
    expect(coordinator.read("following")).toMatchObject({ status: "requested" });
    expect(coordinator.read("stale")).toMatchObject({
      status: "failed",
      code: "workspace_changed",
    });
    expect(commands.some((argv) => argv.includes("push") || argv.includes("POST"))).toBe(false);
  });

  it.each(["fresh", "historical"] as const)(
    "preserves %s publication outcomes when managed credentials are unavailable",
    async (attempt) => {
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
      coordinator.read("create-schema");
      const requestId = "publication-missing-credential";
      seedLocalPublication(database, {
        requestId,
        status: "requested",
        headCommit: attempt === "fresh" ? null : NEW_HEAD,
      });
      const config = { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } };
      mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
      const { prepareGitHubPublicationIdentity } = await vi.importActual<
        typeof import("../agents/github-tool-identity.js")
      >("../agents/github-tool-identity.js");
      mocks.prepareIdentity.mockImplementation(prepareGitHubPublicationIdentity);

      const resumed = coordinator.resumeSessionRequests();
      if (attempt === "historical") {
        await expect(resumed).rejects.toThrow("GitHub publication is unconfirmed");
        expect(coordinator.read(requestId)).toMatchObject({ status: "publishing" });
      } else {
        await resumed;
        expect(coordinator.read(requestId)).toMatchObject({
          status: "failed",
          code: "identity_unavailable",
          nextAction: expect.stringContaining("Reconnect"),
        });
      }
      expect(commands.some((argv) => argv.includes("push") || argv.includes("POST"))).toBe(false);
    },
  );

  it("terminalizes local recovery when the managed worktree fingerprint changed", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const first = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    first.read("create-schema");
    const requestId = "publication-stale-worktree";
    seedLocalPublication(database, {
      requestId,
      status: "requested",
      repositoryFingerprint: "replaced-fingerprint",
    });
    await closeStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const resumed = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database: reopened }),
    });

    await resumed.resumeSessionRequests();

    expect(resumed.read(requestId)).toEqual({
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
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database }),
    });
    coordinator.read("create-schema");
    const requestId = "publication-stale-session-owner";
    seedLocalPublication(database, { requestId, status: "requested" });
    mocks.findWorktreeById.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: SESSION_KEY,
    });
    mocks.findWorktree.mockReturnValue({
      id: "worktree-1",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:replacement",
    });

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(requestId)).toMatchObject({
      status: "failed",
      code: "session_changed",
    });
    expect(commands).toEqual([]);
  });

  it.each(["fresh", "historical"] as const)(
    "preserves %s publication outcomes before probing unsafe Git configuration",
    async (attempt) => {
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
      coordinator.read("create-schema");
      const requestId = "publication-unsafe-recovery";
      seedLocalPublication(database, {
        requestId,
        status: "requested",
        headCommit: attempt === "fresh" ? null : NEW_HEAD,
      });
      mocks.findWorktreeById.mockReturnValue({
        id: "worktree-1",
        repoRoot: "/repo",
        repoFingerprint: "fingerprint-1",
        path: "/repo/worktree",
        branch: BRANCH,
        baseRef: "origin/main",
        ownerKind: "session",
        ownerId: SESSION_KEY,
      });
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (argv.includes("--local") && argv.includes("--get-regexp")) {
          return commandResult("core.fsmonitor ./untrusted-monitor\n");
        }
        return await fallback(argv, options);
      });

      const resumed = coordinator.resumeSessionRequests();
      if (attempt === "historical") {
        await expect(resumed).rejects.toThrow("GitHub publication is unconfirmed");
        expect(coordinator.read(requestId)).toMatchObject({ status: "publishing" });
      } else {
        await resumed;
        expect(coordinator.read(requestId)).toMatchObject({
          status: "failed",
          code: "workspace_changed",
        });
      }
      expect(commands.some((argv) => argv.join(" ") === "git rev-parse --git-path index")).toBe(
        false,
      );
    },
  );

  it.each([
    { label: "no live claim", claimRunId: undefined, expectedRunId: undefined },
    { label: "another active turn", claimRunId: "run-active", expectedRunId: undefined },
    { label: "a mismatched run identity", claimRunId: "run-active", expectedRunId: "run-other" },
    { label: "its own active turn", claimRunId: "run-active", expectedRunId: "run-active" },
  ])("queues a cloud session publication with $label", async ({ claimRunId, expectedRunId }) => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    seedAttachedPlacementEnvironment(database, {
      environmentId: "environment-deferred-request",
      sessionId: REQUEST.sessionId,
      ownerEpoch: 2,
    });
    const active = await seedActivePlacement(placements, {
      environmentId: "environment-deferred-request",
      ownerEpoch: 2,
    });
    const claim = claimRunId
      ? await placements.claimTurn({
          sessionId: active.sessionId,
          sessionKey: active.sessionKey,
          agentId: active.agentId,
          claimId: "claim-active",
          runId: claimRunId,
          owner: { kind: "worker", environmentId: "environment-deferred-request", ownerEpoch: 2 },
        })
      : undefined;
    const coordinator = createTestGitHubPublicationCoordinator({ placements });

    const result = await coordinator.requestForSession({
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "deferred-cloud-request",
      ...(expectedRunId ? { expectedRunId } : {}),
    });
    const acceptedClaim = claim?.runId === expectedRunId ? claim : undefined;

    expect(result).toMatchObject({ status: "requested" });
    expect(
      database.db
        .prepare(
          "SELECT claim_id, run_id, environment_id, owner_epoch, placement_generation, source_head_commit, source_index_tree, workspace_tree FROM github_publication_requests WHERE request_id = ?",
        )
        .get(result.requestId),
    ).toEqual({
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
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    seedAttachedPlacementEnvironment(database, {
      environmentId: "environment-accepted-deferred",
      sessionId: REQUEST.sessionId,
      ownerEpoch: 2,
    });
    const active = await seedActivePlacement(placements, {
      environmentId: "environment-accepted-deferred",
      ownerEpoch: 2,
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });
    const deferred = await coordinator.requestForSession({
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-deferred-session",
    });
    const claim = await placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-accepted-deferred",
      runId: "run-accepted-deferred",
      owner: { kind: "worker", environmentId: "environment-accepted-deferred", ownerEpoch: 2 },
    });
    const claimed = await coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-claim-session",
    });
    placements.markWorkspaceResultPending(claim);
    await coordinator.prepareClaimWorkspace(claim);
    placements.acceptWorkspaceResult(claim);

    await expect(coordinator.processClaim(claim)).resolves.toEqual([
      expect.objectContaining({ requestId: claimed.requestId, status: "published" }),
      expect.objectContaining({ requestId: deferred.requestId, status: "published" }),
    ]);
  });

  it("defers an orphaned turn request and publishes it when the workspace is quiescent", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    seedAttachedPlacementEnvironment(database, {
      environmentId: "environment-1",
      sessionId: REQUEST.sessionId,
      ownerEpoch: 2,
    });
    const active = await seedActivePlacement(placements, {
      environmentId: "environment-1",
      ownerEpoch: 2,
    });
    const claim = await placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-orphan",
      runId: "run-orphan",
      owner: { kind: "worker", environmentId: "environment-1", ownerEpoch: 2 },
    });
    const coordinator = createTestGitHubPublicationCoordinator({ placements });
    const accepted = await coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "publish-orphan",
    });
    await placements.releaseTurn(claim);

    coordinator.deferOrphanedRequests();

    expect(coordinator.read(accepted.requestId)).toMatchObject({ status: "requested" });
    expect(coordinator.listUnreportedResults()).toEqual([]);
    expect(commands).toEqual([]);

    await coordinator.resumeSessionRequests();

    expect(coordinator.read(accepted.requestId)).toMatchObject({ status: "published" });
    expect(coordinator.listUnreportedResults()).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ status: "published" }) }),
    ]);
  });

  it("defers snapshot preparation failures without blocking workspace acceptance", async () => {
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    seedAttachedPlacementEnvironment(database, {
      environmentId: "environment-snapshot-failure",
      sessionId: REQUEST.sessionId,
      ownerEpoch: 2,
    });
    const active = await seedActivePlacement(placements, {
      environmentId: "environment-snapshot-failure",
      ownerEpoch: 2,
    });
    const claim = await placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "claim-snapshot-failure",
      runId: "run-snapshot-failure",
      owner: {
        kind: "worker",
        environmentId: "environment-snapshot-failure",
        ownerEpoch: 2,
      },
    });
    const runtime = createGitHubPublicationRuntime({
      placements,
      loadSessionRuntime: async () => {
        throw new Error("not used");
      },
      warn: () => undefined,
    });
    const requested = await runtime.coordinator.requestForClaim({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "snapshot-failure",
    });
    placements.markWorkspaceResultPending(claim);
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
      argv.includes("--get-regexp")
        ? commandResult("filter.attacker.clean ./run-attacker\n")
        : await fallback(argv, options),
    );

    await expect(runtime.prepareAcceptedWorkspacePublication(claim)).resolves.toBeUndefined();
    expect(
      database.db
        .prepare(
          "SELECT claim_id, run_id, environment_id, owner_epoch, placement_generation, gateway_instance_id FROM github_publication_requests WHERE request_id = ?",
        )
        .get(requested.requestId),
    ).toEqual({
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      gateway_instance_id: null,
    });
    expect(() => placements.acceptWorkspaceResult(claim)).not.toThrow();
    await runtime.coordinator.resumeSessionRequests();
    expect(runtime.coordinator.read(requested.requestId)).toMatchObject({ status: "requested" });
    mocks.runCommand.mockImplementation(fallback);
    placements.completeWorkspaceResultAndReleaseTurn(claim);

    await runtime.coordinator.resumeSessionRequests();

    expect(runtime.coordinator.read(requested.requestId)).toMatchObject({ status: "published" });
  });
});
