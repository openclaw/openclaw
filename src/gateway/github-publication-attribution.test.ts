// Register identity and transport mocks before loading either publication executor.
// oxfmt-ignore
import {
  BRANCH,
  NEW_HEAD,
  SESSION_KEY,
  publicationRequest,
  commandCalls,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  publicationWorktree,
  registryPublicationWorktree,
  root,
} from "./github-publication.test-support.js";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createInitialSubagentSession } from "../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { getRuntimeConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.test-support.js";
import { syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import * as publicationExecutor from "./github-publication-executor.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import * as repositoryPublicationExecutor from "./github-repository-publication-executor.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

function createPerson(accountId: number, login: string) {
  return syncGitHubIdentity({
    identity: { accountId, login },
    authenticationAlias: { kind: "email", email: `${login}@example.test` },
  });
}

function participate(id: string, sessionKey = SESSION_KEY, promptedAt = 1) {
  recordSessionParticipant(
    { agentId: "main", sessionKey },
    { identity: { type: "profile", id }, promptedAt, sessionAgentId: "main" },
  );
}

async function useRealAttribution() {
  const { prepareGitCoauthorAttribution, resolveGitCoauthorAttribution } = await vi.importActual<
    typeof import("../agents/git-coauthor-attribution.js")
  >("../agents/git-coauthor-attribution.js");
  mocks.prepareAttribution.mockImplementation(prepareGitCoauthorAttribution);
  mocks.attribution.mockImplementation(resolveGitCoauthorAttribution);
}

async function prepareRealPublicationCredit() {
  const alice = createPerson(7, "alice");
  participate(alice.id);
  await useRealAttribution();
  return alice;
}

function optOut(person: ReturnType<typeof createPerson>) {
  expect(setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }).ok).toBe(true);
}

const creditRejected = {
  status: "failed",
  code: "identity_changed",
  nextAction: expect.stringMatching(/credit/i),
};

describe("Gateway GitHub publication attribution", () => {
  installGitHubPublicationTestHarness();

  it("emits a Git-recognized coauthor trailer even when the title contains the exact credit", async () => {
    await persistPublicationTestSession();
    await prepareRealPublicationCredit();
    const trailer = "Co-authored-by: alice <7+alice@users.noreply.github.com>";
    const coordinator = createGitHubPublicationCoordinator();
    const result = await coordinator.requestForSessionV2(
      publicationRequest("credit-in-title", { title: trailer }),
    );

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
      (["preparation", "push", "pull_request"] as const).map((boundary) => ({ surface, boundary })),
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
      const revokeCredit = () => {
        optOut(person);
        optedOut = true;
      };
      const executed: string[][] = [];
      const hasCommand = (command: string, endpoint?: string) =>
        executed.some(
          (args) =>
            args.includes(command) && (!endpoint || args.some((arg) => arg.endsWith(endpoint))),
        );
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
          revokeCredit();
        }
        return result;
      });
      if (boundary !== "preparation") {
        type RecordEffect = NonNullable<
          Parameters<typeof publicationExecutor.executeGitHubPublication>[0]["recordEffect"]
        >;
        const revokeAfter =
          (record: RecordEffect) =>
          async (effect: Parameters<RecordEffect>[0], observed?: Parameters<RecordEffect>[1]) => {
            await record(effect, observed);
            if (effect === boundary && observed === undefined) {
              revokeCredit();
            }
          };
        const executeLocal = publicationExecutor.executeGitHubPublication;
        const executeRepository = repositoryPublicationExecutor.executeRepositoryGitHubPublication;
        const intercepted =
          surface === "local"
            ? vi
                .spyOn(publicationExecutor, "executeGitHubPublication")
                .mockImplementation((params) =>
                  executeLocal({
                    ...params,
                    recordEffect: revokeAfter((effect, observed) =>
                      params.recordEffect?.(effect, observed),
                    ),
                  }),
                )
            : vi
                .spyOn(repositoryPublicationExecutor, "executeRepositoryGitHubPublication")
                .mockImplementation((params) =>
                  executeRepository({
                    ...params,
                    execution: {
                      ...params.execution,
                      recordEffect: revokeAfter((effect, observed) =>
                        params.execution.recordEffect(effect, observed),
                      ),
                    },
                  }),
                );
        onTestFinished(() => intercepted.mockRestore());
      }
      const coordinator = repository?.coordinator ?? createGitHubPublicationCoordinator();
      const result = await coordinator.requestForSessionV2(
        publicationRequest(`opt-out-${surface}-${boundary}`),
      );

      expect(optedOut).toBe(true);
      expect(result).toMatchObject(creditRejected);
      expect(
        executed.filter((args) => args.includes("push") || args.includes("graphql")),
      ).toHaveLength(boundary === "pull_request" ? 1 : 0);
      expect(hasCommand("POST", "/pulls")).toBe(false);
      if (boundary === "preparation") {
        expect(hasCommand("commit-tree") || hasCommand("POST", "/git/commits")).toBe(false);
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
      const request = publicationRequest("unpushed-credit-recovery");
      const interrupted = await repository.coordinator.requestForSessionV2(request);
      expect(interrupted.status).toBe("requested");
      expect(readRepositoryGitHubPublication(interrupted.requestId)?.head_commit).toBeTruthy();
      expect(repository.runtime).toMatchObject({ head: null, effects: [] });

      if (credit === "revoked") {
        optOut(person);
      }
      mocks.runCommand.mockClear().mockImplementation(transport);
      const resumed = await repository.coordinator.requestForSessionV2(request);

      expect(resumed).toMatchObject(creditRejected);
      expect(repository.runtime).toMatchObject({ head: null, effects: [] });
      expect(mocks.runCommand.mock.calls.some(([argv]) => argv.includes("graphql"))).toBe(false);
    },
  );

  it("publishes inherited and direct human credit once with current consent and a final session backlink", async () => {
    const config = {
      gateway: { publicOrigin: "https://team.example", controlUi: { basePath: "/control" } },
    };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    await useRealAttribution();
    const people = [
      createPerson(7, "alice"),
      // Grace contributed earlier in the source session; session-level credit follows delegation.
      createPerson(9, "grace"),
      createPerson(11, "opted-out"),
    ];
    people.forEach(({ id }) => participate(id));
    const childKey = "agent:main:subagent:delegated-publication";
    const child = await createInitialSubagentSession({
      cfg: config,
      requesterAgentId: "main",
      targetAgentId: "main",
      childSessionKey: childKey,
      incognito: false,
      requesterInternalKey: SESSION_KEY,
      parentTarget: await resolveGatewaySessionStoreTargetInWorker({
        cfg: config,
        key: SESSION_KEY,
        agentId: "main",
        projection: "full",
      }),
      creationPolicy: { actor: { type: "agent", id: "main" } },
      completionOwnerSessionKey: SESSION_KEY,
      modelPatch: {},
      collect: false,
    });
    expect(child.status).toBe("ok");
    participate(createPerson(13, "later-contributor").id, SESSION_KEY, 3);
    const worktree = registryPublicationWorktree({
      ...publicationWorktree(childKey),
      id: "delegated-worktree",
      path: "/repo/delegated-worktree",
    });
    await insertRegistryWorktree(process.env, worktree);
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
    participate(people[0]!.id, childKey, 2);
    optOut(people[2]!);
    const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
      typeof import("./session-utils-store-worker.js")
    >("./session-utils-store-worker.js");
    mocks.loadSession.mockImplementation((key: string, options?: { agentId?: string }) =>
      loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key,
        ...options,
        readOnly: true,
      }),
    );
    const coordinator = createGitHubPublicationCoordinator();

    const result = await coordinator.requestForSessionV2(
      publicationRequest("ordered-attribution", {
        sessionKey: childKey,
        title: "fix: publish the reconciled fix",
        body: "Detailed proof\n\n## Worked on by\n\n- @untrusted\n\n### Verification notes\n\nKeep this paragraph.\n\n---\n[View the OpenClaw team session](https://untrusted.example/session)",
      }),
    );

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
    const coordinator = createGitHubPublicationCoordinator();

    const result = await coordinator.requestForSessionV2(publicationRequest("local-session-url"));

    expect(result).toMatchObject({ status: "published" });
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null").body).toBe(
      `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${result.requestId} -->`,
    );
  });
});
