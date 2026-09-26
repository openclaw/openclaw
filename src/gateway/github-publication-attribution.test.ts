// Register identity and transport mocks before loading either publication executor.
// oxfmt-ignore
import {
  BRANCH,
  NEW_HEAD,
  SESSION_KEY,
  commandCalls,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createInitialSubagentSession } from "../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.js";
import { syncGitHubIdentity } from "../state/user-profiles.js";
import * as publicationExecutor from "./github-publication-executor.js";
import { readGitHubPublicationRequest } from "./github-publication-store.js";
import * as repositoryPublicationExecutor from "./github-repository-publication-executor.js";
import { readRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

async function prepareRealPublicationCredit() {
  const person = syncGitHubIdentity({
    identity: { accountId: 7, login: "alice" },
    authenticationAlias: { kind: "email", email: "alice@example.test" },
  });
  recordSessionParticipant(
    { agentId: "main", sessionKey: SESSION_KEY },
    { identity: { type: "profile", id: person.id }, promptedAt: 1, sessionAgentId: "main" },
  );
  const { prepareGitCoauthorAttribution, resolveGitCoauthorAttribution } = await vi.importActual<
    typeof import("../agents/git-coauthor-attribution.js")
  >("../agents/git-coauthor-attribution.js");
  mocks.prepareAttribution.mockImplementation(prepareGitCoauthorAttribution);
  mocks.attribution.mockImplementation(resolveGitCoauthorAttribution);
  return person;
}

describe("Gateway GitHub publication attribution", () => {
  installGitHubPublicationTestHarness();

  it("emits a Git-recognized coauthor trailer even when the title contains the exact credit", async () => {
    await persistPublicationTestSession();
    await prepareRealPublicationCredit();
    const trailer = "Co-authored-by: alice <7+alice@users.noreply.github.com>";
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
    });
    const result = await coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "credit-in-title",
      title: trailer,
    });

    expect(result.status).toBe("published");
    const message = commandCalls.find(({ argv }) => argv.includes("commit-tree"))?.input;
    expect(message).toBeDefined();
    const parsed = execFileSync("git", ["interpret-trailers", "--parse", "--no-divider"], {
      cwd: root,
      input: message,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_CONFIG_COUNT: "0",
      },
    });
    expect(parsed.trim().split("\n")).toEqual([
      trailer,
      `OpenClaw-Publication: ${result.requestId}`,
    ]);
  });

  it.each(
    (["local", "repository"] as const).flatMap((surface) =>
      (["preparation", "push", "pull_request"] as const).map((boundary) => ({
        surface,
        boundary,
      })),
    ),
  )(
    "honors opt-out at $surface $boundary without new credited effects",
    async ({ surface, boundary }) => {
      const repository =
        surface === "repository" ? await createRepositoryPublicationFixture(checkpoint) : undefined;
      if (!repository) {
        await persistPublicationTestSession();
      }
      const person = await prepareRealPublicationCredit();
      let optedOut = false;
      const optOut = () => {
        expect(setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }).ok).toBe(
          true,
        );
        optedOut = true;
      };
      const executed: string[][] = [];
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options) => {
        executed.push(argv);
        const result = await transport(argv, options);
        if (
          boundary === "preparation" &&
          !optedOut &&
          (surface === "local"
            ? argv.includes("cat-file") && argv.includes("-e")
            : argv.some((arg) => arg.endsWith("/git/blobs")))
        ) {
          optOut();
        }
        return result;
      });
      if (boundary !== "preparation") {
        if (surface === "local") {
          const execute = publicationExecutor.executeGitHubPublication;
          const intercepted = vi
            .spyOn(publicationExecutor, "executeGitHubPublication")
            .mockImplementation((params) =>
              execute({
                ...params,
                recordEffect: (effect, observed) => {
                  params.recordEffect?.(effect, observed);
                  if (effect === boundary && observed === undefined) {
                    optOut();
                  }
                },
              }),
            );
          onTestFinished(() => intercepted.mockRestore());
        } else {
          const execute = repositoryPublicationExecutor.executeRepositoryGitHubPublication;
          const intercepted = vi
            .spyOn(repositoryPublicationExecutor, "executeRepositoryGitHubPublication")
            .mockImplementation((params) =>
              execute({
                ...params,
                execution: {
                  ...params.execution,
                  recordEffect: (effect, observed) => {
                    params.execution.recordEffect(effect, observed);
                    if (effect === boundary && observed === undefined) {
                      optOut();
                    }
                  },
                },
              }),
            );
          onTestFinished(() => intercepted.mockRestore());
        }
      }
      const coordinator =
        repository?.coordinator ??
        createGitHubPublicationCoordinator({
          placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
        });
      const result = await coordinator.requestForSession({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: `opt-out-${surface}-${boundary}`,
      });

      expect(optedOut).toBe(true);
      expect(result).toMatchObject({
        status: "failed",
        code: "identity_changed",
        nextAction: expect.stringMatching(/credit/i),
      });
      expect(
        executed.filter((args) => args.includes("push") || args.includes("graphql")),
      ).toHaveLength(boundary === "pull_request" ? 1 : 0);
      expect(
        executed.some(
          (args) => args.includes("POST") && args.some((arg) => arg.endsWith("/pulls")),
        ),
      ).toBe(false);
      if (boundary === "preparation") {
        expect(
          executed.some(
            (args) =>
              args.includes("commit-tree") ||
              (args.includes("POST") && args.some((arg) => arg.endsWith("/git/commits"))),
          ),
        ).toBe(false);
      }
      if (boundary === "pull_request") {
        if (repository) {
          expect(readRepositoryGitHubPublication(result.requestId)?.pushed_head_commit).toBe(
            repository.runtime.head,
          );
          expect(repository.runtime.effects).toEqual(["push"]);
        } else {
          expect(
            readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
              requestId: result.requestId,
            })?.head_commit,
          ).toBe(NEW_HEAD);
        }
      }
    },
  );

  it.each(["revoked", "body-only"] as const)(
    "does not resume an unpushed checkpoint commit containing %s credit",
    async (credit) => {
      const repository = await createRepositoryPublicationFixture(checkpoint);
      const person = await prepareRealPublicationCredit();
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options) => {
        if (argv.includes("graphql")) {
          throw new Error("Synthetic interruption before the remote ref update");
        }
        if (
          credit === "body-only" &&
          argv.includes("POST") &&
          argv.some((arg) => arg.endsWith("/git/commits"))
        ) {
          const commit = JSON.parse(options.input);
          const marker = commit.message.match(/^OpenClaw-Publication: .+$/mu)?.[0];
          expect(marker).toBeDefined();
          // Retain a real Git object produced by an older publisher whose credit was only prose.
          commit.message = `Prepared change\n\nCo-authored-by: alice <7+alice@users.noreply.github.com>\n\nThe line above is quoted attribution.\n\n${marker}\n`;
          return await transport(argv, { ...options, input: JSON.stringify(commit) });
        }
        return await transport(argv, options);
      });
      const request = {
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "unpushed-credit-recovery",
      };
      const interrupted = await repository.coordinator.requestForSession(request);
      expect(interrupted.status).toBe("requested");
      expect(readRepositoryGitHubPublication(interrupted.requestId)?.head_commit).toBeTruthy();
      expect(repository.runtime.head).toBeNull();
      expect(repository.runtime.effects).toEqual([]);

      if (credit === "revoked") {
        expect(setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }).ok).toBe(
          true,
        );
      }
      mocks.runCommand.mockClear().mockImplementation(transport);
      const resumed = await repository.coordinator.requestForSession(request);

      expect(resumed).toMatchObject({
        status: "failed",
        code: "identity_changed",
        nextAction: expect.stringMatching(/credit/i),
      });
      expect(repository.runtime.head).toBeNull();
      expect(repository.runtime.effects).toEqual([]);
      expect(mocks.runCommand.mock.calls.some(([argv]) => argv.includes("graphql"))).toBe(false);
    },
  );

  it("publishes inherited and direct human credit once with current consent and a final session backlink", async () => {
    const config = {
      gateway: { publicOrigin: "https://team.example", controlUi: { basePath: "/control" } },
    };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    const { prepareGitCoauthorAttribution, resolveGitCoauthorAttribution } = await vi.importActual<
      typeof import("../agents/git-coauthor-attribution.js")
    >("../agents/git-coauthor-attribution.js");
    mocks.prepareAttribution.mockImplementation(prepareGitCoauthorAttribution);
    mocks.attribution.mockImplementation(resolveGitCoauthorAttribution);
    const people = [
      { accountId: 7, login: "alice" },
      // Grace contributed earlier in the source session; session-level credit follows delegation.
      { accountId: 9, login: "grace" },
      { accountId: 11, login: "opted-out" },
    ].map((identity) =>
      syncGitHubIdentity({
        identity,
        authenticationAlias: { kind: "email", email: `${identity.login}@example.test` },
      }),
    );
    for (const person of people) {
      recordSessionParticipant(
        { agentId: "main", sessionKey: SESSION_KEY },
        { identity: { type: "profile", id: person.id }, promptedAt: 1, sessionAgentId: "main" },
      );
    }
    const childKey = "agent:main:subagent:delegated-publication";
    const child = await createInitialSubagentSession({
      cfg: config,
      targetAgentId: "main",
      childSessionKey: childKey,
      incognito: false,
      requesterInternalKey: SESSION_KEY,
      creationPolicy: { actor: { type: "agent", id: "main" } },
      completionOwnerSessionKey: SESSION_KEY,
      modelPatch: {},
      collect: false,
    });
    expect(child.status).toBe("ok");
    const laterContributor = syncGitHubIdentity({
      identity: { accountId: 13, login: "later-contributor" },
      authenticationAlias: { kind: "email", email: "later-contributor@example.test" },
    });
    recordSessionParticipant(
      { agentId: "main", sessionKey: SESSION_KEY },
      {
        identity: { type: "profile", id: laterContributor.id },
        promptedAt: 3,
        sessionAgentId: "main",
      },
    );
    const worktree = {
      id: "delegated-worktree",
      name: "delegated-publication",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/delegated-worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session" as const,
      ownerId: childKey,
      createdAt: 1,
      lastActiveAt: 1,
    };
    insertRegistryWorktree(process.env, worktree);
    mocks.findWorktree.mockReturnValue(worktree);
    mocks.findWorktreeById.mockReturnValue(worktree);
    mocks.resolveRepository.mockResolvedValue({
      checkoutRoot: worktree.path,
      repoRoot: worktree.repoRoot,
      originUrl: "git@github.com:openclaw/openclaw.git",
      fingerprint: worktree.repoFingerprint,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey },
      { worktree: { id: worktree.id, branch: BRANCH, repoRoot: "/repo" } },
    );
    recordSessionParticipant(
      { agentId: "main", sessionKey: childKey },
      { identity: { type: "profile", id: people[0]!.id }, promptedAt: 2, sessionAgentId: "main" },
    );
    setUserPreferences(people[2]!.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
    const { loadGatewaySessionEntryReadOnly } =
      await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
    mocks.loadSession.mockImplementation(loadGatewaySessionEntryReadOnly);
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: childKey,
      agentId: "main",
      idempotencyKey: "ordered-attribution",
      title: "fix: publish the reconciled fix",
      body: "Detailed proof\n\n## Worked on by\n\n- @untrusted\n\n### Verification notes\n\nKeep this paragraph.\n\n---\n[View the OpenClaw team session](https://untrusted.example/session)",
    });

    expect(result).toMatchObject({ status: "published" });
    expect(commandCalls.find(({ argv }) => argv.includes("commit-tree"))?.input).toBe(
      `fix: publish the reconciled fix\n\nWorked on by:\n- @alice\n- @grace\n\nCo-authored-by: alice <7+alice@users.noreply.github.com>\nCo-authored-by: grace <9+grace@users.noreply.github.com>\nOpenClaw-Publication: ${result.requestId}\n`,
    );
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null")).toEqual({
      title: "fix: publish the reconciled fix",
      body: `Detailed proof\n\n### Verification notes\n\nKeep this paragraph.\n\n## Worked on by\n\n- @alice\n- @grace\n\n<!-- openclaw-publication:${result.requestId} -->\n\n---\n[View the OpenClaw team session](https://team.example/control/chat/main/subagent/delegated-publication)`,
      head: `openclaw:${BRANCH}`,
      base: "main",
      draft: true,
    });
  });

  it("publishes without a session footer when the configured URL is not external HTTPS", async () => {
    const config = { gateway: { publicOrigin: "http://127.0.0.1:18789" } };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "local-session-url",
    });

    expect(result).toMatchObject({ status: "published" });
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null").body).toBe(
      `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${result.requestId} -->`,
    );
  });
});
