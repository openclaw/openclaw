// Register shared transport mocks before production publication owners load.
// oxfmt-ignore
import {
  installGitHubPublicationTestHarness,
  overrideCommands,
  commandResult,
  githubPublicationTestMocks,
} from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.js";
import {
  decodeGitHubPublicationRequester,
  encodeGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import * as userProfileList from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  syncCanonicalGitHubIdentity,
} from "../state/user-profile-writes.js";
import { inspectOwnGitHubPullRequest } from "./github-publication-inspect.js";
import {
  captureGitHubPublicationActionAuthority,
  prepareGitHubPublicationRequesterV2,
  prepareGitHubPublicationTaskRequester,
  restoreGitHubPublicationRequester,
} from "./github-publication-requester.js";
import {
  withPublicationGuestRole,
  createRequesterPublicationFixture,
  holdWorkerTurn,
  publicationGuestEmail as email,
  resumePublicationFixture,
} from "./github-publication-requester.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";

const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic checkpoints isolate publication from real repository and session state.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
installGitHubPublicationTestHarness({
  creatorEmail: email,
  sandbox: "required",
  realWorktree: true,
});
beforeEach(async () => {
  onTestFinished((await userProfileList.prepareUserProfileCatalog()).release);
});

async function participantFixture(
  backend: "local" | "repository" = "local",
  scopes: OperatorScope[] = ["operator.sessions.read"],
) {
  const f = await fixture(backend);
  const session = { ...f.guestSource.session, sessionId: f.session.sessionId };
  const profileId = (
    await ensureCanonicalUserProfileForEmail("publication-participant@example.test")
  ).id;
  await upsertSessionEntryCore(session, {
    sessionRoot: f.local?.cwd ?? "/repo/worktree",
    visibility: "read-only",
  });
  await addSessionMember(session, {
    identityId: profileId,
    addedBy: f.maintainerProfile,
    access: "send",
  });
  let config = withPublicationGuestRole(f.config, {
    scopes,
    sessions: { others: "invited", maxInvitedAccess: "send", invitedTools: ["github_publish"] },
  });
  setRuntimeConfigSnapshot(config);
  const client = createOperatorWsClient({ connId: profileId, scopes });
  client.authenticatedUserProfile = {
    ...f.guestSource.client.authenticatedUserProfile!,
    profileId,
  };
  prepareGatewayConnectOperatorAccess(client);
  client.internal = { ...client.internal, authenticatedOperator: true };
  const context = createDirectChatContext({ getRuntimeConfig: () => config });
  const captureParticipant = async (participantClient = client) => {
    const turn = await resolveSessionMutationAuthorizationAsync({
      client: participantClient,
      context,
      method: "chat.send",
      requestParams: session,
    });
    expect(turn.error).toBeNull();
    onTestFinished(() => turn.authorization?.release?.());
    const captured = await prepareGitHubPublicationRequesterV2(
      { client: participantClient, context, sessionMutationAuthorization: turn.authorization },
      session,
    );
    onTestFinished(captured.release);
    return captured;
  };
  const commands = githubPublicationTestMocks().runCommand;
  const transport = commands.getMockImplementation()!;
  commands.mockImplementation(async (argv, options) => {
    const endpoint = argv.at(-1);
    if (
      argv[0] !== "gh" ||
      !endpoint ||
      !/^repos\/(?:openclaw\/openclaw|owner\/repository)(?:\/pulls\/\d+)?$/.test(endpoint)
    ) {
      return transport(argv, options);
    }
    const repo = { id: 10, private: false, full_name: endpoint.split("/").slice(1, 3).join("/") };
    if (!endpoint.includes("/pulls/")) {
      const value =
        backend === "repository"
          ? JSON.parse((await transport(argv, options)).stdout.toString())
          : {};
      return commandResult(JSON.stringify({ ...value, ...repo }));
    }
    const result = await transport(argv, options);
    const value = JSON.parse(result.stdout.toString());
    return commandResult(
      JSON.stringify({
        ...value,
        node_id: "PR_shared_participant",
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        merge_commit_sha: null,
        title: "Shared publication",
        user: { ...value.user, login: "publisher" },
        head: { ...value.head, repo: { ...repo, ...value.head.repo } },
        base: { ...value.base, sha: "a".repeat(40), repo: { ...repo, ...value.base.repo } },
      }),
    );
  });
  const captured = await captureParticipant();
  return {
    ...f,
    guestProfile: profileId,
    session,
    captured,
    captureParticipant,
    client,
    context,
    getConfig: () => config,
    setRole(overrides: Parameters<typeof withPublicationGuestRole>[1]) {
      config = withPublicationGuestRole(config, overrides);
      setRuntimeConfigSnapshot(config);
    },
  };
}

it("retains a send participant across recovery without lending creator or admin power", async () => {
  const f = await participantFixture();
  const { session, captured, getConfig } = f;
  expect(captured.requester.snapshot.actor).toEqual({
    kind: "operator",
    profileId: f.guestProfile,
  });
  expect(captured.requester.snapshot.scopes).toEqual(["operator.sessions.read"]);
  expect(captureGitHubPublicationActionAuthority(captured.requester).operatorWrite).toBe(false);
  const json = encodeGitHubPublicationRequester(captured.requester.snapshot);
  const restored = await restoreGitHubPublicationRequester(json, session, getConfig);
  onTestFinished(restored.release);
  expect(() => restored.assertCurrent()).not.toThrow();
  await expect(
    restoreGitHubPublicationRequester(
      json,
      {
        ...session,
        sessionKey: "agent:main:missing-publication",
      },
      getConfig,
    ),
  ).rejects.toThrow();
  f.setRole({ scopes: ["operator.admin"] });
  expect(() => restored.assertCurrent()).not.toThrow();
  expect(captureGitHubPublicationActionAuthority(restored).operatorWrite).toBe(false);
  f.setRole({ sessions: { others: "invited", maxInvitedAccess: "send" } });
  expect(() => restored.assertCurrent()).not.toThrow();
  const original = captured.requester.snapshot;
  const participation = original.participation!;
  expect(Object.isFrozen(participation.ceiling.source)).toBe(true);
  expect(Object.isFrozen(decodeGitHubPublicationRequester(json)?.participation?.target)).toBe(true);
  for (const patch of [
    { tools: undefined },
    { tools: ["read"] },
    ...[
      { agentId: "other" },
      { sessionId: "replacement" },
      { lifecycleRevision: "replacement" },
      { creatorProfileId: f.guestProfile },
      { root: "/replacement" },
    ].map((change) => ({ source: { ...participation.ceiling.source, ...change } })),
  ]) {
    await expect(
      restoreGitHubPublicationRequester(
        encodeGitHubPublicationRequester({
          ...original,
          participation: { ...participation, ceiling: { ...participation.ceiling, ...patch } },
        }),
        session,
        getConfig,
      ),
    ).rejects.toThrow();
  }
  for (const patch of [{ sessionId: "replacement" }, { lifecycleRevision: "replacement" }]) {
    await expect(
      restoreGitHubPublicationRequester(
        encodeGitHubPublicationRequester({
          ...original,
          participation: { ...participation, target: { ...participation.target, ...patch } },
        }),
        session,
        getConfig,
      ),
    ).rejects.toThrow();
  }
  await setSessionMemberAccess(session, { identityId: f.guestProfile, access: "read" });
  expect(() => restored.assertCurrent()).toThrow();
  await expect(restoreGitHubPublicationRequester(json, session, getConfig)).rejects.toThrow();
  await setSessionMemberAccess(session, { identityId: f.guestProfile, access: "send" });
  const renewed = await restoreGitHubPublicationRequester(json, session, getConfig);
  onTestFinished(renewed.release);
  f.setRole({
    sessions: { others: "invited", maxInvitedAccess: "send", invitedTools: ["github_publish"] },
  });
  const invocation = await f.captureParticipant();
  expect(invocation.requester.snapshot).toEqual(renewed.snapshot);
  const claim = await holdWorkerTurn(f);
  const queued = await f.coordinator.requestForSessionV2(
    f.request("participant-recovery", invocation.requester),
  );
  expect(queued.status).toBe("requested");
  f.setRole({ sessions: { others: "invited", maxInvitedAccess: "send", invitedTools: ["read"] } });
  expect(() => renewed.assertCurrent()).toThrow();
  await f.placements.releaseTurn(claim);
  const restarted = await resumePublicationFixture(f);
  expect(await restarted.readAsync(queued.requestId)).toMatchObject({
    status: "failed",
    code: "identity_changed",
  });
  expect(f.externalWrites).toEqual([]);
});

it("binds inherited participant callers and task handoffs to their exact target", async () => {
  const f = await participantFixture();
  const { captured, session, getConfig, context } = f;
  const participation = captured.requester.snapshot.participation!;
  const source = (await captureGatewayOperatorRunAuthority({ client: f.client, context }))!;
  onTestFinished(source.release);
  const authority = createAdmittedRunOperatorAuthority({
    ...source.authority,
    participationCeiling: participation.ceiling,
  });
  const child = { agentId: "main", sessionKey: "agent:main:subagent:publication-participant" };
  await upsertSessionEntryCore(child, {
    sessionId: "participant-child",
    updatedAt: 1,
    parentSessionKey: session.sessionKey,
    createdActor: { type: "human", source: "profile", id: f.guestProfile },
    inheritedToolPolicySource: "participant",
    participationCeiling: participation.ceiling,
  });
  for (const target of [session, child]) {
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: [...authority.scopes],
      operatorRunAuthority: authority,
      agentToolCaller: { ...target, assertCurrent: authority.assertCurrent },
    });
    const current = await prepareGitHubPublicationRequesterV2({ client, context }, target);
    onTestFinished(current.release);
    expect(current.requester.snapshot.actor).toEqual(captured.requester.snapshot.actor);
    expect(current.requester.snapshot.participation?.ceiling).toEqual(participation.ceiling);
    await expect(
      prepareGitHubPublicationRequesterV2(
        { client, context },
        {
          ...target,
          sessionKey: "agent:main:foreign-publication",
        },
      ),
    ).rejects.toThrow();
    await expect(
      current.requester.prepareSource({
        ...participation.target,
        sessionKey: "agent:main:foreign-publication",
      }),
    ).rejects.toThrow();
  }
  const noCaller = createSyntheticPluginRuntimeClient({
    operatorRunAuthority: authority,
    scopes: [...authority.scopes],
  });
  await expect(
    prepareGitHubPublicationRequesterV2({ client: noCaller, context }, session),
  ).rejects.toThrow();
  const transferred = await prepareGitHubPublicationTaskRequester(
    captured.requester,
    child,
    participation.target,
    getConfig,
  );
  onTestFinished(transferred.release);
  expect(transferred.requester.snapshot.origin).toEqual(participation.target);
  expect(transferred.requester.snapshot.participation).toEqual({
    ceiling: participation.ceiling,
    target: { ...child, sessionId: "participant-child", lifecycleRevision: null },
  });
  expect(transferred.requester.snapshot.actor).toEqual(captured.requester.snapshot.actor);
  const recovered = await restoreGitHubPublicationRequester(
    encodeGitHubPublicationRequester(transferred.requester.snapshot),
    child,
    getConfig,
  );
  onTestFinished(recovered.release);
  await upsertSessionEntryCore(session, { sessionRoot: "/replaced-participation-source" });
  expect(() => recovered.assertCurrent()).toThrow();
});

it.each([false, true])(
  "publishes participants through shared RPC with linked personal credentials=%s",
  async (linked) => {
    const f = await participantFixture();
    const personal = vi.spyOn(f.coordinator, "requestPersonalForSessionV2");
    const source = (await captureGatewayOperatorRunAuthority({
      client: f.client,
      context: f.context,
    }))!;
    onTestFinished(source.release);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      ...source.authority,
      participationCeiling: f.captured.requester.snapshot.participation!.ceiling,
    });
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "operator", profileId: f.guestProfile },
      authenticatedUserProfile: f.client.authenticatedUserProfile,
      scopes: [...operatorAuthority.scopes],
      operatorRunAuthority: operatorAuthority,
      agentToolCaller: {
        agentId: f.session.agentId,
        sessionKey: f.session.sessionKey,
        assertCurrent: operatorAuthority.assertCurrent,
      },
    });
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn();
      await withGatewayToolCallerIdentity(
        { agentId: f.session.agentId, sessionKey: f.session.sessionKey, operatorAuthority },
        () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: method,
              method: `sessions.github.${method}`,
              params: { agentId: f.session.agentId, sessionKey: f.session.sessionKey, ...params },
            },
            client,
            context: { ...f.context, githubPublicationService: f.coordinator },
            isWebchatConnect: () => false,
            respond,
          }),
      );
      expect(respond).toHaveBeenCalledWith(true, expect.anything());
      return respond.mock.calls[0]![1];
    };
    if (linked) {
      updateUserGitHubConnection(
        f.guestProfile,
        () => ({
          version: 1,
          generation: randomUUID(),
          selection: {
            kind: "connected",
            profileId: "ghp_22222222222222222222222222222222",
            accountId: 501,
            login: "participant-personal",
            refreshToken: "synthetic-participant-refresh",
            accessExpiresAtMs: Date.now() + 3600000,
            refreshExpiresAtMs: Date.now() + 86400000,
            scopes: ["repo"],
          },
        }),
        f.captured.requester.assertCurrent,
      );
    }
    const first = await rpc("publish", { idempotencyKey: "accountless-shared" });
    expect(first).toMatchObject({ status: "published", publisher: { accountId: 42 } });
    expect(f.readRequester(first.requestId)?.actor).toEqual({
      kind: "operator",
      profileId: f.guestProfile,
    });
    expect(await rpc("publish", { idempotencyKey: "accountless-shared" })).toMatchObject({
      requestId: first.requestId,
      status: "published",
    });
    const update = await f.coordinator.requestForSessionV2(
      f.request("maintainer-update", f.maintainer),
    );
    expect(update.status).toBe("published");
    expect(await rpc("action", { action: "edit" })).toMatchObject({ title: "Shared publication" });
    expect((await rpc("options", {})).personal).toBeNull();
    expect(await rpc("status", { requestId: first.requestId })).toMatchObject({
      result: { status: "published" },
    });
    expect(personal).not.toHaveBeenCalled();
    expect(f.local!.effects).toEqual(["push", "pull_request"]);
  },
);

it.each([
  { backend: "local", change: "queued" },
  { backend: "local", change: "descendant" },
  { backend: "repository", change: "checkpoint" },
] as const)(
  "rejects another participant's $backend PR reuse with $change work before writes",
  async ({ backend, change }) => {
    const f = await participantFixture(backend);
    const other = (await ensureCanonicalUserProfileForEmail("other-participant@example.test")).id;
    await addSessionMember(f.session, {
      identityId: other,
      addedBy: f.maintainerProfile,
      access: "send",
    });
    const client = createOperatorWsClient({ connId: other, scopes: ["operator.sessions.read"] });
    client.authenticatedUserProfile = { ...f.client.authenticatedUserProfile!, profileId: other };
    prepareGatewayConnectOperatorAccess(client);
    client.internal = { ...client.internal, authenticatedOperator: true };
    const second = await f.captureParticipant(client);
    if (change === "queued") {
      const claim = await holdWorkerTurn(f);
      const first = await f.coordinator.requestForSessionV2(
        f.request("first-participant", f.captured.requester),
      );
      const queued = await f.coordinator.requestForSessionV2(
        f.request("second-participant", second.requester),
      );
      expect([first.status, queued.status]).toEqual(["requested", "requested"]);
      await f.placements.releaseTurn(claim);
      const resumed = await resumePublicationFixture(f);
      expect(await resumed.readAsync(first.requestId)).toMatchObject({ status: "published" });
      expect(await resumed.readAsync(queued.requestId)).toMatchObject({ status: "failed" });
    } else {
      expect(
        await f.coordinator.requestForSessionV2(
          f.request("first-participant", f.captured.requester),
        ),
      ).toMatchObject({ status: "published" });
      if (f.local) {
        await fs.writeFile(path.join(f.local.cwd, "artifact.txt"), "committed descendant\n");
        await f.local.git("add", "artifact.txt");
        await f.local.git("commit", "-m", "descendant work");
      } else {
        await f.repository!.capture("updated checkpoint\n", "second-participant");
      }
      const writes = [...f.externalWrites];
      const rejected = await f.coordinator.requestForSessionV2(
        f.request("second-participant", second.requester),
      );
      expect(f.externalWrites).toEqual(writes);
      expect(rejected).toMatchObject({ status: "failed" });
      expect(
        await f.coordinator.requestForSessionV2(f.request("original-update", f.captured.requester)),
      ).toMatchObject({ status: "published" });
    }
    expect(f.local?.effects ?? f.repository!.runtime.effects).toEqual(
      change === "queued" ? ["push", "pull_request"] : ["push", "pull_request", "push"],
    );
    await expect(
      inspectOwnGitHubPullRequest({
        pullRequestUrl: `https://github.com/${backend === "local" ? "openclaw/openclaw/pull/125200" : "owner/repository/pull/1"}`,
        session: f.session,
        requester: second.requester,
        assertCurrent: second.requester.assertCurrent,
      }),
    ).rejects.toThrow();
  },
);

it.each(["local", "repository"] as const)(
  "denies %s shared participant workflow edits despite original operator.write",
  async (backend) => {
    const f = await participantFixture(backend, ["operator.write"]);
    const filename = ".github/workflows/participant.yml";
    const content = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
    if (f.local) {
      await fs.mkdir(path.join(f.local.cwd, ".github/workflows"), { recursive: true });
      await fs.writeFile(path.join(f.local.cwd, filename), content);
    } else {
      const repository = f.repository!;
      await repository.capture("accepted workflow\n", "participant-workflow", {
        [filename]: content,
      });
    }
    const result = await f.coordinator.requestForSessionV2(
      f.request("participant-workflow", f.captured.requester),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "github_rejected",
      nextAction: expect.stringMatching(/OpenClaw.*not a GitHub token scope/),
    });
    expect(f.local?.effects ?? f.repository!.runtime.effects).toEqual([]);
  },
);

it("requires participant PR authorship rather than another publisher PR's contributor credit", async () => {
  const f = await participantFixture();
  await syncCanonicalGitHubIdentity({
    identity: { accountId: 101, login: "participant" },
    authenticationAlias: { kind: "email", email: "publication-participant@example.test" },
  });
  const repo = { id: 10, full_name: "owner/repository", private: false };
  const url = "https://github.com/owner/repository/pull/7";
  const pr = {
    number: 7,
    html_url: url,
    user: { id: 101, login: "participant" },
    state: "open",
    draft: false,
    merged: false,
    base: { repo, ref: "main", sha: "a".repeat(40) },
    head: { repo, ref: "topic", sha: "b".repeat(40) },
  };
  overrideCommands((argv) => {
    if (argv.includes("graphql")) {
      return commandResult(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: pr.head.sha,
                commits: {
                  nodes: [
                    {
                      commit: {
                        id: "commit-node",
                        authors: {
                          nodes: [{ user: { databaseId: 101 } }],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                        committer: { user: { databaseId: 101 } },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    }
    const endpoint = argv.at(-1);
    return endpoint === "repos/owner/repository"
      ? commandResult(JSON.stringify(repo))
      : endpoint === "repos/owner/repository/pulls/7"
        ? commandResult(JSON.stringify(pr))
        : undefined;
  });
  const inspect = () =>
    inspectOwnGitHubPullRequest({
      pullRequestUrl: url,
      session: f.session,
      requester: f.captured.requester,
      assertCurrent: f.captured.requester.assertCurrent,
    });
  expect((await inspect()).result.author.accountId).toBe(101);
  pr.user = { id: 42, login: "publisher" };
  await expect(inspect()).rejects.toThrow("not authored by a GitHub account linked to you");
  expect(f.externalWrites).toEqual([]);
});
