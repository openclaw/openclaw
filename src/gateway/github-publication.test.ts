import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import * as publicationLifecycles from "../state/github-publication-session-lifecycles.js";
import { holdNextReply } from "../state/github-publication.worker.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  publicationRequest,
  WORKSPACE_TREE,
  commandCalls,
  commandResult,
  commands,
  createSystemGitHubPublicationRequesterFixture,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  createTestGitHubPublicationRuntime as createGitHubPublicationRuntime,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistClaimPublicationWorkspace,
  persistPublicationTestSession,
  publicationTranscriptMessages,
  root,
  seedLocalPublication,
  withPublicationWorktreeSqlBoundary,
} from "./github-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const mocks = githubPublicationTestMocks();
const PULL_URL = "https://github.com/openclaw/openclaw/pull/125200";
const POST_PULL =
  "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -";
const SHOW_HEAD = "git show -s --no-show-signature --format=%H%n%T%n%P%n%B HEAD";
const repository = {
  checkoutRoot: "/repo/worktree",
  repoRoot: "/repo",
  originUrl: "git@github.com:openclaw/openclaw.git",
  fingerprint: "fingerprint-1",
};
const openDatabase = () => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
const coordinatorFor = (database: ReturnType<typeof openDatabase>) =>
  createGitHubPublicationCoordinator({
    placements: createWorkerSessionPlacementStore({ database }),
  });
const publish = (idempotencyKey: string) =>
  createGitHubPublicationCoordinator().requestForSessionV2(publicationRequest(idempotencyKey));
const commandMatches = (...args: string[]) =>
  commands.filter((argv) => args.every((arg) => argv.includes(arg)));
const commandMatchesAny = (...args: string[]) =>
  commands.filter((argv) => args.some((arg) => argv.includes(arg)));
const githubPosts = () => commandMatches("POST").filter(([program]) => program === "gh");
const pullLookup = (command: string) =>
  command.includes("repos/openclaw/openclaw/pulls") && command.includes("state=all");

function overrideCommands(
  reply: (
    command: string,
    argv: string[],
    input?: string,
  ) => ReturnType<typeof commandResult> | undefined,
  record = false,
) {
  const fallback = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    const result = reply(argv.join(" "), argv, options?.input);
    if (result && record) {
      commands.push(argv);
      commandCalls.push({ argv, input: options?.input });
    }
    return result ?? (await fallback(argv, options));
  });
}

async function workerClaim(environmentId: string, suffix: string) {
  const database = openDatabase();
  const placements = createWorkerSessionPlacementStore({ database });
  seedAttachedPlacementEnvironment(database, {
    environmentId,
    sessionId: REQUEST.sessionId,
    ownerEpoch: 2,
  });
  const active = await seedActivePlacement(placements, { environmentId, ownerEpoch: 2 });
  const claim = await placements.claimTurn({
    sessionId: active.sessionId,
    sessionKey: active.sessionKey,
    agentId: active.agentId,
    claimId: `claim-${suffix}`,
    runId: `run-${suffix}`,
    owner: { kind: "worker", environmentId, ownerEpoch: 2 },
  });
  return { database, placements, claim };
}

async function loadSessionRuntime() {
  const { resolveCanonicalSessionEntryFromStoreKeys } = await import("./session-utils.js");
  const { resolveGatewaySessionStoreTargetInWorker } =
    await import("./session-utils-store-worker.js");
  return { resolveCanonicalSessionEntryFromStoreKeys, resolveGatewaySessionStoreTargetInWorker };
}

const publishedResult = (requestId: string) => ({
  publisher: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
  requestId,
  status: "published",
  url: PULL_URL,
  repository: "openclaw/openclaw",
  branch: BRANCH,
  headCommit: NEW_HEAD,
});

function publicationPull(
  overrides: Partial<Record<"url" | "state" | "body" | "baseRef", string>> = {},
) {
  return {
    url: PULL_URL,
    userId: 42,
    state: "open",
    body: "",
    headSha: NEW_HEAD,
    headRef: BRANCH,
    baseRef: "main",
    ...overrides,
  };
}
const pullResponse = (overrides: Parameters<typeof publicationPull>[0]) =>
  commandResult(JSON.stringify([publicationPull(overrides)]));
const workerTranscript = ({ agentId, sessionId, sessionKey } = REQUEST) =>
  loadTranscriptEvents({ agentId, sessionId, sessionKey });

describe("Gateway GitHub publication", () => {
  installGitHubPublicationTestHarness();
  it("warns that retired publication methods fail instead of promising continued support", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const coordinator = createGitHubPublicationCoordinator();
      withPluginRuntimePluginScope({ pluginId: "publication-compat-diagnostic" }, () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(() => coordinator.deferOrphanedRequests()).toThrow(
            "Use deferOrphanedRequestsAsync and await completion.",
          );
        }
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "Plugin publication-compat-diagnostic: deferOrphanedRequests is deprecated; use deferOrphanedRequestsAsync instead. This method no longer performs publication work; use its replacement. Final compatibility day: 2026-12-31. Removal ships in the first January 2027 stable release; no SDK major is required.",
        { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("does not create publication state when reading an absent receipt", async () => {
    const database = openOpenClawStateDatabase();
    // Older admitted stores can lack this additive, first-publication table.
    database.db.exec("DROP TABLE IF EXISTS github_publication_requests");
    const coordinator = coordinatorFor(database);
    expect(await coordinator.readAsync("absent")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("github_publication_requests"),
    ).toBeUndefined();
  });

  it("publishes through exact HTTPS and replays the durable terminal result", async () => {
    await persistPublicationTestSession();
    const { requester } = await createSystemGitHubPublicationRequesterFixture();
    const database = openDatabase();
    const coordinator = coordinatorFor(database);
    const request = publicationRequest("publish-1", { title: "Publish the reconciled fix" });

    const first = await coordinator.requestForSessionV2({ ...request, requester });
    expect(first).toEqual(publishedResult(expect.any(String)));
    expect(commands.some((argv) => argv.includes("https://github.com/openclaw/openclaw.git"))).toBe(
      true,
    );
    expect(commands.some((argv) => argv.some((arg) => arg.includes("roboclaw-token")))).toBe(false);
    for (const argv of commandMatchesAny("update-ref", "read-tree", "add", "reset", "push")) {
      expect(argv, argv.join(" ")).toContain(`core.hooksPath=${os.devNull}`);
    }
    for (const argv of commandMatchesAny("read-tree", "add", "reset")) {
      expect(argv).toContain("core.fsmonitor=false");
    }
    const push = commands.find((argv) => argv.includes("push"));
    expect(push?.[0]).toBe("git");
    expect(push).toEqual(
      expect.arrayContaining([
        "--no-follow-tags",
        "--recurse-submodules=no",
        "credential.helper=!gh auth git-credential",
        `${NEW_HEAD}:refs/heads/${BRANCH}`,
      ]),
    );
    expect(push).not.toContain(`HEAD:refs/heads/${BRANCH}`);
    const fetch = commands.find((argv) => argv.includes("fetch"));
    expect(fetch).toEqual(
      expect.arrayContaining([
        `core.hooksPath=${os.devNull}`,
        "core.fsmonitor=false",
        "--no-auto-maintenance",
        "--recurse-submodules=no",
      ]),
    );
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(post?.argv).toEqual(POST_PULL.split(" "));
    expect(JSON.parse(post?.input ?? "null")).toEqual({
      title: "Publish the reconciled fix",
      body: `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${first.requestId} -->`,
      head: `openclaw:${BRANCH}`,
      base: "main",
      draft: false,
    });
    for (const [, options] of mocks.runCommand.mock.calls) {
      expect(options?.env).toMatchObject(
        appendGitConfig(gitMaintenanceEnvironment(), [["core.hooksPath", os.devNull]]),
      );
    }
    const persisted = database.db
      .prepare("SELECT * FROM github_publication_requests WHERE session_id = ?")
      .get(SESSION_ID);
    expect(JSON.stringify(persisted)).not.toMatch(/GH_CONFIG_DIR|token/);

    const commandCount = commands.length;
    await closeStateDatabaseForTest();
    const reopened = openDatabase();
    const afterRestart = coordinatorFor(reopened);
    const resumed = await createSystemGitHubPublicationRequesterFixture();
    await expect(
      afterRestart.requestForSessionV2({ ...request, requester: resumed.requester }),
    ).resolves.toEqual(first);
    expect(commands).toHaveLength(commandCount);
  });

  it("reuses an existing upstream pull request for a fork head", async () => {
    mocks.resolveRepository.mockResolvedValue({
      ...repository,
      originUrl: "git@github.com:roboclaw-bot/openclaw.git",
    });
    overrideCommands((command) => {
      if (command.startsWith("gh api --hostname github.com repos/roboclaw-bot/openclaw --jq")) {
        return commandResult(
          '{"fork":true,"default_branch":"main","parent":{"name":"openclaw","default_branch":"main","owner":{"login":"openclaw"}}}\n',
        );
      }
      if (command.includes("ls-remote") && command.includes("roboclaw-bot/openclaw.git")) {
        return commandResult(`${NEW_HEAD}\trefs/heads/${BRANCH}\n`);
      }
      if (pullLookup(command)) {
        return pullResponse({ url: "https://github.com/openclaw/openclaw/pull/125201" });
      }
      return undefined;
    });
    const result = await publish("fork-existing-pr");
    expect(result).toMatchObject({
      status: "published",
      repository: "openclaw/openclaw",
      url: "https://github.com/openclaw/openclaw/pull/125201",
    });
    expect(
      mocks.runCommand.mock.calls.some(([argv]) =>
        argv.includes("head=roboclaw-bot:openclaw/publication"),
      ),
    ).toBe(true);
    expect(mocks.runCommand.mock.calls.some(([argv]) => argv.includes("POST"))).toBe(false);
  });

  it.each([
    { state: "open" as const, expectedStatus: "published" as const },
    { state: "closed" as const, expectedStatus: "failed" as const },
  ])(
    "handles a $state pull request after a lost POST response",
    async ({ state, expectedStatus }) => {
      let pullLookups = 0;
      let createdBody = "";
      overrideCommands((command, _argv, input) => {
        if (pullLookup(command)) {
          pullLookups += 1;
          return pullLookups < 3
            ? commandResult("[]\n")
            : pullResponse({
                url: "https://github.com/openclaw/openclaw/pull/125203",
                state,
                body: createdBody,
              });
        }
        if (command === POST_PULL) {
          createdBody = String(JSON.parse(input ?? "{}").body ?? "");
          return commandResult("", 1);
        }
        return undefined;
      });
      const result = await publish("lost-post-response");
      expect(result).toMatchObject(
        expectedStatus === "published"
          ? { status: "published", url: "https://github.com/openclaw/openclaw/pull/125203" }
          : {
              status: "failed",
              code: "github_rejected",
              nextAction:
                "Reopen the closed pull request or retry to create a new publication request.",
            },
      );
      expect(mocks.runCommand.mock.calls.filter(([argv]) => argv.includes("POST"))).toHaveLength(1);
      expect(pullLookups).toBe(3);
    },
  );

  it("does not reuse an open pull request targeting a different base branch", async () => {
    overrideCommands((command) => {
      if (pullLookup(command)) {
        return pullResponse({
          url: "https://github.com/openclaw/openclaw/pull/old-base",
          baseRef: "release",
        });
      }
      if (command === POST_PULL) {
        return commandResult(
          '{"html_url":"https://github.com/openclaw/openclaw/pull/right-base"}\n',
        );
      }
      return undefined;
    });
    const result = await publish("wrong-base-pr");
    expect(result).toMatchObject({
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/right-base",
    });
    const lookup = mocks.runCommand.mock.calls.find(
      ([argv]) => argv.includes("state=all") && argv.includes("head=openclaw:openclaw/publication"),
    );
    expect(lookup?.[0]).toContain("base=main");
    expect(mocks.runCommand.mock.calls.filter(([argv]) => argv.includes("POST"))).toHaveLength(1);
  });

  it("rejects an effective clean filter before snapshotting workspace content", async () => {
    overrideCommands((_command, argv) => {
      if (argv.includes("ls-tree")) {
        return commandResult(`100644 blob ${"f".repeat(40)}\t.GITATTRIBUTES\0`);
      }
      if (argv.includes("cat-file") && argv.includes("blob")) {
        return commandResult("*.bin filter=lfs\n");
      }
      return undefined;
    });
    await expect(publish("active-clean-filter")).rejects.toThrow("unsupported Git clean filter");
    expect(commands.some((argv) => argv.includes("commit-tree"))).toBe(false);
  });

  it.each([
    { rejection: "redirected-checkout", forbidden: "commit-tree" },
    { rejection: "symbolic-branch", forbidden: "update-ref" },
  ])("rejects $rejection before mutating the worktree", async ({ rejection, forbidden }) => {
    if (rejection === "redirected-checkout") {
      mocks.resolveRepository.mockResolvedValue({
        ...repository,
        checkoutRoot: "/tmp/other-checkout",
      });
    } else {
      overrideCommands((command) =>
        command === `git symbolic-ref --quiet refs/heads/${BRANCH}`
          ? commandResult("refs/heads/main\n")
          : undefined,
      );
    }
    expect(await publish(rejection)).toMatchObject({ status: "failed", code: "workspace_changed" });
    expect(commandMatches(forbidden)).toHaveLength(0);
    expect(commandMatches("push")).toHaveLength(0);
  });

  it("fails a restarted request when the branch advanced beyond its accepted snapshot", async () => {
    const database = openDatabase();
    const coordinator = coordinatorFor(database);
    const requestId = "publication-stale-snapshot";
    seedLocalPublication(database, { requestId, status: "publishing" });
    overrideCommands((command) => {
      if (command === SHOW_HEAD) {
        return commandResult(
          `${"f".repeat(40)}\n${WORKSPACE_TREE}\n${OLD_HEAD}\nA later local commit\n`,
        );
      }
      return undefined;
    });

    await coordinator.resumeSessionRequests();

    expect(await coordinator.readAsync(requestId)).toMatchObject({
      status: "failed",
      code: "workspace_changed",
    });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it.for(["settled", "pending"] as const)(
    "singleflights concurrent coordinators with %s duplicate admission before any Git or GitHub mutation",
    async (admission, { signal }) => {
      const repositoryEntered = createDeferred();
      const { promise: repositoryReady, resolve: releaseRepository } = createDeferred();
      mocks.resolveRepository.mockImplementationOnce(async () => {
        repositoryEntered.resolve();
        await repositoryReady;
        return { ...repository };
      });
      const database = openDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      const first = createGitHubPublicationCoordinator({ placements });
      const second = createGitHubPublicationCoordinator({ placements });
      const request = publicationRequest("publication-concurrent", { title: "Publish once" });

      const lifecycleAttempted = createDeferred();
      let duplicatePending = false;
      const prepareLifecycle = publicationLifecycles.prepareGitHubPublicationSessionLifecycle;
      const observeLifecycle = vi
        .spyOn(publicationLifecycles, "prepareGitHubPublicationSessionLifecycle")
        .mockImplementation(async (input) => {
          const authority = await prepareLifecycle(input);
          return {
            readCurrent() {
              try {
                return authority.readCurrent();
              } finally {
                if (duplicatePending) {
                  lifecycleAttempted.resolve();
                }
              }
            },
          };
        });
      const requests = [first.requestForSessionV2(request)];
      let duplicateReply: ReturnType<typeof holdNextReply> | undefined;
      let stopObserving: (() => void) | undefined;
      try {
        await withinTest(Promise.race([repositoryEntered.promise, ...requests]), signal);
        const duplicateSettled = createDeferred();
        let duplicateOperation: string | undefined;
        stopObserving = githubPublicationReceipts.subscribeFacts((change) => {
          if (change.kind === "pending") {
            duplicateOperation = change.operationId;
          } else if (change.kind === "settled" && change.operationId === duplicateOperation) {
            duplicateSettled.resolve();
          }
        });
        duplicateReply = holdNextReply("githubPublications.insert");
        requests.push(second.requestForSessionV2(request));
        await withinTest(Promise.race([duplicateReply.ready, ...requests]), signal);
        expect(mocks.resolveRepository).toHaveBeenCalledOnce();
        if (admission === "settled") {
          duplicateReply.release();
          await withinTest(duplicateSettled.promise, signal);
        }
        duplicatePending = admission === "pending";
        releaseRepository();
        if (duplicatePending) {
          await withinTest(Promise.race([lifecycleAttempted.promise, ...requests]), signal);
        }
        // Release the duplicate's native settlement before joining either caller.
        duplicateReply.release();
        // A duplicate admission cannot revoke the immutable lifecycle binding.
        await expect(Promise.all(requests)).resolves.toEqual([
          expect.objectContaining({ status: "published" }),
          expect.objectContaining({ status: "published" }),
        ]);
      } finally {
        releaseRepository();
        duplicateReply?.release();
        await Promise.allSettled(requests);
        stopObserving?.();
        observeLifecycle.mockRestore();
      }

      expect(mocks.resolveRepository).toHaveBeenCalledOnce();
      expect(commandMatches("commit-tree")).toHaveLength(1);
      const fetchIndex = commands.findIndex((argv) => argv.includes("fetch"));
      const commitIndex = commands.findIndex((argv) => argv.includes("commit-tree"));
      const updateRefIndex = commands.findIndex((argv) => argv.includes("update-ref"));
      expect(fetchIndex).toBeGreaterThanOrEqual(0);
      expect(commitIndex).toBeGreaterThan(fetchIndex);
      expect(updateRefIndex).toBeGreaterThan(commitIndex);
      expect(commandMatches("push")).toHaveLength(1);
      expect(githubPosts()).toHaveLength(1);
    },
  );

  it("binds the accepted worker snapshot before acceptance and never recaptures it", async () => {
    await persistClaimPublicationWorkspace();
    const { database, placements, claim } = await workerClaim("environment-snapshot", "snapshot");
    const runtime = createGitHubPublicationRuntime({
      placements,
      loadSessionRuntime: async () => {
        throw new Error("not used");
      },
      warn: () => undefined,
    });
    const requested = await runtime.coordinator.requestForClaimV2({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-snapshot",
    });
    await placements.markWorkspaceResultPending(claim);

    await runtime.prepareAcceptedWorkspacePublication(claim);

    const stored = database.db
      .prepare(
        "SELECT source_head_commit, source_index_tree, workspace_tree FROM github_publication_requests WHERE request_id = ?",
      )
      .get(requested.requestId);
    expect(stored).toEqual({
      source_head_commit: OLD_HEAD,
      source_index_tree: WORKSPACE_TREE,
      workspace_tree: WORKSPACE_TREE,
    });
    const snapshotCommandCount = commandMatches("write-tree").length;
    overrideCommands((command) =>
      command === "git write-tree" ? commandResult(`${"f".repeat(40)}\n`) : undefined,
    );
    await expect(runtime.prepareAcceptedWorkspacePublication(claim)).resolves.toBeUndefined();
    expect(commandMatches("write-tree")).toHaveLength(snapshotCommandCount);
  });

  it.each(["repository identity", "newer same-owner row", "restored same-owner row"] as const)(
    "fences publication after %s changes without caller-thread worktree SQL",
    async (change) => {
      await withPublicationWorktreeSqlBoundary(change, async (changeWorktree) => {
        mocks.resolveRepository.mockImplementationOnce(async () => {
          await changeWorktree();
          return { ...repository };
        });
        const database = openDatabase();
        const coordinator = coordinatorFor(database);
        await expect(
          coordinator.requestForSessionV2(
            publicationRequest("publish-stale-worktree-await", { title: "Publish safely" }),
          ),
        ).resolves.toEqual({
          requestId: expect.any(String),
          publisher: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
          status: "failed",
          code: "workspace_changed",
          message: "GitHub publication failed.",
          nextAction:
            "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
        });
        expect(commandMatchesAny("commit-tree", "push", "POST")).toEqual([]);
      });
    },
  );

  it.each([
    { phase: "commit", remoteInitiallyPublished: false, pullRequestExists: false },
    { phase: "pull request", remoteInitiallyPublished: true, pullRequestExists: true },
    { phase: "body-only credit", remoteInitiallyPublished: false, pullRequestExists: false },
  ])(
    "validates prepared credit when resuming after $phase",
    async ({ phase, remoteInitiallyPublished, pullRequestExists }) => {
      const bodyOnlyCredit = phase === "body-only credit";
      const database = openDatabase();
      const requestId = `publication-after-${phase.replaceAll(" ", "-")}`;
      seedLocalPublication(database, { requestId, status: "publishing" });
      await closeStateDatabaseForTest();

      let remotePublished = remoteInitiallyPublished;
      overrideCommands((command, argv) => {
        if (command === "git rev-parse --verify HEAD^{commit}") {
          return commandResult(`${NEW_HEAD}\n`);
        }
        if (command === SHOW_HEAD) {
          return commandResult(
            `${NEW_HEAD}\n${WORKSPACE_TREE}\n${OLD_HEAD}\nResume the publication\n\n` +
              "Co-authored-by: alice <7+alice@users.noreply.github.com>\n" +
              (bodyOnlyCredit ? "\nThe line above is quoted attribution.\n\n" : "") +
              `OpenClaw-Publication: ${requestId}\n`,
          );
        }

        if (
          command.startsWith(
            "git -c credential.helper= -c credential.helper=!gh auth git-credential ls-remote",
          )
        ) {
          return commandResult(remotePublished ? `${NEW_HEAD}\trefs/heads/${BRANCH}\n` : "");
        }
        if (argv.includes("push")) {
          remotePublished = true;
          return commandResult();
        }
        if (pullLookup(command)) {
          return commandResult(pullRequestExists ? JSON.stringify([publicationPull()]) : "[]\n");
        }
        return undefined;
      }, true);
      const reopened = openDatabase();
      const resumed = coordinatorFor(reopened);

      await resumed.resumeSessionRequests();

      if (bodyOnlyCredit) {
        expect(await resumed.readAsync(requestId)).toMatchObject({
          status: "failed",
          code: "identity_changed",
          nextAction: expect.stringMatching(/credit/i),
        });
        expect(commandMatchesAny("commit-tree", "push", "POST")).toEqual([]);
        return;
      }

      expect(await resumed.readAsync(requestId)).toEqual(publishedResult(requestId));
      expect(commandMatches("commit-tree")).toHaveLength(0);
      expect(commandMatches("--force")).toHaveLength(0);
      expect(commandMatches("push")).toHaveLength(remoteInitiallyPublished ? 0 : 1);
      expect(githubPosts()).toHaveLength(pullRequestExists ? 0 : 1);
      const commandCount = commands.length;
      await resumed.resumeSessionRequests();
      expect(commands).toHaveLength(commandCount);
    },
  );

  it("reports an in-run publication notice into the requesting run", async () => {
    await persistPublicationTestSession();
    const runtime = createGitHubPublicationRuntime({
      placements: createWorkerSessionPlacementStore({ database: openDatabase() }),
      loadSessionRuntime,
      warn: (message) => {
        throw new Error(message);
      },
    });

    const result = await runtime.coordinator.requestForSessionV2(
      publicationRequest("publish-during-run", { expectedRunId: "run-publishing" }),
    );
    expect(result.status).toBe("published");
    await runtime.reconcilePublications();

    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    expect(publicationTranscriptMessages(events, result.requestId)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          __openclaw: expect.objectContaining({ runId: "run-publishing" }),
        }),
      }),
    ]);
    expect(await runtime.coordinator.listUnreportedResultsAsync()).toEqual([]);
  });

  it("projects an accepted worker publication exactly once across transcript-report restart", async () => {
    const { placements, claim } = await workerClaim(
      "environment-publication",
      "publication-integration",
    );
    await persistClaimPublicationWorkspace();
    const warnings: string[] = [];
    const runtime = createGitHubPublicationRuntime({
      placements,
      loadSessionRuntime,
      warn: (message) => warnings.push(message),
    });
    const requested = await runtime.coordinator.requestForClaimV2({
      claim,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      idempotencyKey: "accepted-workspace-publication",
      title: "Publish the accepted workspace",
    });
    await placements.markWorkspaceResultPending(claim);
    await runtime.prepareAcceptedWorkspacePublication(claim);
    await placements.acceptWorkspaceResult(claim);
    const processClaim = vi
      .spyOn(runtime.coordinator, "processClaim")
      .mockRejectedValueOnce(new Error("transient publication failure"));
    await expect(runtime.publishAcceptedWorkspace(claim)).rejects.toThrow(
      "transient publication failure",
    );
    expect(warnings).toEqual([expect.stringContaining("GitHub publication deferred")]);
    processClaim.mockRestore();
    warnings.length = 0;
    vi.spyOn(runtime.coordinator, "markReportedAsync").mockImplementationOnce(() => {
      throw new Error("Gateway stopped after transcript append");
    });

    await expect(runtime.publishAcceptedWorkspace(claim)).resolves.toBeUndefined();
    expect(warnings).toEqual([
      expect.stringContaining("GitHub publication result reporting deferred"),
    ]);
    expect(await runtime.coordinator.readAsync(requested.requestId)).toMatchObject({
      status: "published",
    });
    expect(await runtime.coordinator.listUnreportedResultsAsync()).toHaveLength(1);
    let events = await workerTranscript();
    expect(publicationTranscriptMessages(events, requested.requestId)).toHaveLength(1);

    // A process restart also retires the report writer's retained state admission.
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const reopened = openDatabase();
    const restarted = createGitHubPublicationRuntime({
      placements: createWorkerSessionPlacementStore({ database: reopened }),
      loadSessionRuntime,
      warn: (message) => warnings.push(message),
    });
    await restarted.reconcilePublications();
    await restarted.reconcilePublications();

    events = await workerTranscript();
    expect(publicationTranscriptMessages(events, requested.requestId)).toHaveLength(1);
    expect(await restarted.coordinator.listUnreportedResultsAsync()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
