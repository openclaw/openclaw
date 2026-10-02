// Install publication transport mocks before the personal identity owner is loaded.
// oxfmt-ignore
import { SESSION_KEY, createRealPublicationWorkspace, githubPublicationTestMocks, installGitHubPublicationTestHarness, persistPublicationTestSession } from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.js";
import {
  readPersonalGitHubPublication,
  requirePersonalGitHubPublicationConfirmation,
} from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
  restartPersonalPublicationFixture,
} from "./github-personal-publication.test-support.js";
import {
  readGitHubPublicationReview,
  readGitHubPublicationReviewCandidate,
} from "./github-publication-review-store.js";
import { readRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { preparePersonalGitHubSessionAction } from "./server-methods/github-personal-authorization.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

async function fixture(backend: "local" | "repository") {
  const repository =
    backend === "repository" ? await createRepositoryPublicationFixture(checkpoint) : undefined;
  await persistPublicationTestSession();
  const local = backend === "local" ? await createRealPublicationWorkspace() : undefined;
  const person = await createPersonalPublicationFixture();
  if (repository) {
    repository.runtime.accountId = personalPublicationAccount.accountId;
  }
  const selection = {
    source: "personal" as const,
    generation: person.generation,
    account: personalPublicationAccount,
  };
  const prepared = await callPersonalPublicationRpc(person, "sessions.github.review", {
    sessionKey: SESSION_KEY,
    action: "prepare",
    idempotencyKey: "personal-review",
    title: "Reviewed personal change",
    body: "Exact reviewed source",
    selection,
  });
  expect(prepared[0], JSON.stringify(prepared[2])).toBe(true);
  const review = { reviewId: prepared[1].reviewId as string, digest: prepared[1].digest as string };
  const row = (await readGitHubPublicationReview({ reviewId: review.reviewId }))!;
  const candidate = readGitHubPublicationReviewCandidate(row);
  const pages: string[] = [];
  let offset: number | null = 0;
  do {
    const response = await callPersonalPublicationRpc(person, "sessions.github.review", {
      sessionKey: SESSION_KEY,
      action: "diff",
      ...review,
      offset,
    });
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    pages.push(response[1].text);
    offset = response[1].nextOffset;
  } while (offset !== null);
  expect(pages.join("")).toBe(candidate.diff);
  expect(candidate.selection).toEqual(selection);
  expect(candidate.publisher).toMatchObject({ source: "personal", ...personalPublicationAccount });
  expect(row.requester_profile_id).toBe(person.owner);
  expect(JSON.parse(row.requester_authority_json!).actor).toEqual({
    kind: "operator",
    profileId: person.owner,
  });
  expect(candidate.diff).toContain(backend === "local" ? "accepted" : "accepted first");
  if (repository) {
    expect(candidate.workspace).toMatchObject({
      kind: "repository",
      id: repository.workspace.workspaceId,
      checkpointRef: repository.first.ref,
    });
    expect(candidate.snapshot).toMatchObject({
      sourceHeadCommit: repository.baseCommit,
      sourceIndexTree: repository.baseTree,
      workspaceTree: repository.first.workspaceTree,
    });
  }
  const effects = repository?.runtime.effects ?? local!.effects;
  expect(effects).toEqual([]);
  return { person, review, row, candidate, repository, local, effects };
}

describe("personal publication review in a restricted conversation", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["local", "repository"] as const)(
    "publishes the exact %s candidate using the fresh human's selected personal account",
    async (backend) => {
      const f = await fixture(backend);
      const sharedPreparations = mocks.prepareIdentity.mock.calls.length;
      const reply = await callPersonalPublicationRpc(f.person, "sessions.github.publish", {
        sessionKey: SESSION_KEY,
        idempotencyKey: "personal-confirm",
        review: f.review,
        title: "Unreviewed replacement",
        selection: { source: "shared" },
      });
      expect(reply[0], JSON.stringify(reply[2])).toBe(true);
      expect(reply[1]).toMatchObject({
        status: "published",
        publisher: { source: "personal", ...personalPublicationAccount },
      });
      const receipt =
        backend === "repository"
          ? readRepositoryGitHubPublication(reply[1].requestId)
          : readPersonalGitHubPublication(f.person.owner, { requestId: reply[1].requestId });
      expect(receipt).toMatchObject({
        owner_profile_id: f.person.owner,
        connection_generation: f.person.generation,
        identity_source: "personal",
        identity_account_id: personalPublicationAccount.accountId,
      });
      expect(receipt).toMatchObject({
        title: "Reviewed personal change",
        body: "Exact reviewed source",
      });
      expect(mocks.prepareIdentity).toHaveBeenCalledTimes(sharedPreparations);
      expect(f.effects).toEqual(["push", "pull_request"]);
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY })).toMatchObject({
        sandbox: "required",
      });
    },
  );

  it.each(["local", "repository"] as const)(
    "keeps interrupted %s personal publication inert until fresh exact-candidate confirmation",
    async (backend) => {
      const f = await fixture(backend);
      const transport = mocks.runCommand.getMockImplementation()!;
      let lost = false;
      mocks.runCommand.mockImplementation(async (argv, options) => {
        const result = await transport(argv, options);
        if (!lost && (argv.includes("push") || argv.includes("graphql"))) {
          lost = true;
          throw new Error("Synthetic accepted personal push response lost");
        }
        return result;
      });
      const initial = await callPersonalPublicationRpc(f.person, "sessions.github.publish", {
        sessionKey: SESSION_KEY,
        idempotencyKey: "personal-confirm",
        review: f.review,
      });
      expect(initial[0], JSON.stringify(initial[2])).toBe(true);
      const first = initial[1];
      expect(first.status).toBe("needs_confirmation");
      expect(f.effects).toEqual(["push"]);
      const sharedPreparations = mocks.prepareIdentity.mock.calls.length;
      await restartPersonalPublicationFixture(f.person);
      requirePersonalGitHubPublicationConfirmation(f.person.placements.workspaceResultInstanceId());
      await f.person.coordinator.resumeSessionRequests();
      expect(f.effects).toEqual(["push"]);
      f.person.client = { ...f.person.client, connId: "personal-review-reconnect" };
      f.person.runtime.client = f.person.client;
      f.person.action = preparePersonalGitHubSessionAction(f.person, { sessionKey: SESSION_KEY });
      const status = await callPersonalPublicationRpc(f.person, "sessions.github.status", {
        sessionKey: SESSION_KEY,
        requestId: first.requestId,
      });
      expect(status[0], JSON.stringify(status[2])).toBe(true);
      expect(status[1].result.status).toBe("needs_confirmation");
      const facts = status[1].confirmation!;
      const confirm = {
        sessionKey: SESSION_KEY,
        requestId: first.requestId,
        generation: facts.generation,
        account: facts.account,
        requestDigest: facts.requestDigest,
      };
      expect(await f.person.coordinator.confirmPersonal(confirm, f.person.action)).toMatchObject({
        status: "needs_confirmation",
      });
      const denied = await callPersonalPublicationRpc(f.person, "sessions.github.confirm", confirm);
      expect(denied[0]).toBe(false);
      expect(f.effects).toEqual(["push"]);
      expect(mocks.prepareIdentity).toHaveBeenCalledTimes(sharedPreparations);
      const published = await callPersonalPublicationRpc(f.person, "sessions.github.confirm", {
        ...confirm,
        review: f.review,
      });
      expect(published[0], JSON.stringify(published[2])).toBe(true);
      expect(published[1]).toMatchObject({
        requestId: first.requestId,
        status: "published",
        publisher: { source: "personal", ...personalPublicationAccount },
      });
      expect(f.effects).toEqual(["push", "pull_request"]);
      expect(mocks.prepareIdentity).toHaveBeenCalledTimes(sharedPreparations);
      expect(
        readGitHubPublicationReviewCandidate(
          (await readGitHubPublicationReview({ reviewId: f.review.reviewId }))!,
        ),
      ).toEqual(f.candidate);
    },
  );

  it.each(["local", "repository"] as const)(
    "rejects changed personal selection and revoked %s requester before effects",
    async (backend) => {
      const f = await fixture(backend);
      updateUserGitHubConnection(
        f.person.owner,
        (current) => ({ ...current!, generation: randomUUID() }),
        () => {},
      );
      const changed = await callPersonalPublicationRpc(f.person, "sessions.github.publish", {
        sessionKey: SESSION_KEY,
        idempotencyKey: "personal-confirm",
        review: f.review,
      });
      expect(changed[0]).toBe(false);
      f.person.client.connect.scopes = ["operator.read"];
      const revoked = await callPersonalPublicationRpc(f.person, "sessions.github.publish", {
        sessionKey: SESSION_KEY,
        idempotencyKey: "personal-confirm",
        review: f.review,
      });
      expect(revoked[0]).toBe(false);
      expect(f.effects).toEqual([]);
      expect(await readGitHubPublicationReview({ reviewId: f.review.reviewId })).toEqual(f.row);
    },
  );
});
