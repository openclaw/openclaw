// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  WORKSPACE_TREE,
  commandResult,
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { createGitHubPublicationRecoveryBackoff } from "./github-publication-recovery.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import {
  createGitHubPublicationRequesterFixture,
  capturePublicationGuest as guestRequester,
  createRequesterPolicyFixture,
  createRequesterPublicationFixture,
  forPublicationBackends as backendCases,
  guestScopes,
  holdWorkerTurn,
  publicationBackends as backends,
  publicationGuestEmail as email,
  queueGuestPublication as queueGuest,
  requireVisitorPublicationPolicy,
  resumePublicationFixture,
  startVisitorPublicationFixture,
  withPublicationGuestRole,
} from "./github-publication-requester.test-support.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, key: string, requester = f.guest) =>
  f.coordinator.requestForSessionV2(f.request(key, requester));
const identityChanged = { status: "failed", code: "identity_changed" } as const;
const publicationUrl = (backend: (typeof backends)[number]) =>
  backend === "local"
    ? "https://github.com/openclaw/openclaw/pull/125200"
    : "https://github.com/owner/repository/pull/1";
const pullRequest = (
  overrides: Partial<{
    url: string;
    state: string;
    body: string;
    headSha: string;
    baseRef: string;
  }> = {},
) => ({
  url: publicationUrl("local"),
  userId: 42,
  state: "open",
  body: "",
  headSha: NEW_HEAD,
  headRef: BRANCH,
  baseRef: "main",
  ...overrides,
});
const jsonResult = (value: unknown) => commandResult(JSON.stringify(value));
function interceptTransport(
  intercept: (
    argv: string[],
    options: { input?: string } | undefined,
    transport: NonNullable<ReturnType<typeof mocks.runCommand.getMockImplementation>>,
  ) => Promise<ReturnType<typeof commandResult>>,
) {
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation((argv, options) => intercept(argv, options, transport));
}
async function expectResult(
  coordinator: Fixture["coordinator"],
  requestId: string,
  expected: object = { status: "published" },
) {
  expect(await coordinator.readAsync(requestId)).toMatchObject(expected);
}
function expectPending(f: Fixture, requestId: string) {
  const receipt = f.readReceipt(requestId)!;
  expect(["requested", "publishing"]).toContain(receipt.status);
  expect(receipt.error_code).toBeNull();
}
const published = {
  status: "published",
  publisher: { accountId: 42, login: "roboclaw-bot" },
} as const;

describe("shared GitHub publication requester authority", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: email,
    sandbox: "required",
    realWorktree: true,
  });

  it("distinguishes explicit System authority from missing, unclassified, and closed sources", async () => {
    const f = await createRequesterPolicyFixture();
    const { context, session } = f.guestSource;
    const system = await prepareGitHubPublicationRequesterV2(
      {
        client: createSyntheticPluginRuntimeClient({
          operatorRoleActor: { kind: "system" },
          scopes: ["operator.admin"],
        }),
        context,
      },
      session,
    );
    onTestFinished(system.release);
    expect(system.requester.snapshot).toEqual({
      version: 1,
      actor: { kind: "system" },
      scopes: ["operator.admin"],
      grant: null,
    });
    for (const [label, client] of [
      ["missing", null],
      ["unknown", createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] })],
      ["unclassified", { ...f.guestSource.client, internal: undefined }],
    ] as const) {
      await expect(
        prepareGitHubPublicationRequesterV2({ client, context }, session),
        label,
      ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
    }
    const source = (await captureGatewayOperatorRunAuthority({
      client: f.guestSource.client,
      context,
    }))!;
    source.release();
    await expect(
      prepareGitHubPublicationRequesterV2(
        {
          client: {
            ...f.guestSource.client,
            internal: {
              ...f.guestSource.client.internal,
              operatorRunAuthority: source.authority,
            },
          },
          context,
        },
        session,
      ),
    ).rejects.toThrow("no longer active");
    expect(f.externalWrites).toEqual([]);
  });

  it("settles revoked repository requests while waiting for the first checkpoint", async () => {
    const f = await fixture("repository", undefined, { initialCheckpoint: false });
    const accepted = await request(f, "revoked-before-checkpoint");
    expect(accepted.status).toBe("requested");
    await f.revoke();
    const restarted = createTestGitHubPublicationCoordinator({
      placements: f.placements,
      recovery: {
        shared: createGitHubPublicationRecoveryBackoff(),
        repository: createGitHubPublicationRecoveryBackoff(),
      },
    });
    await restarted.resumeSessionRequests();
    await expectResult(restarted, accepted.requestId, identityChanged);
    expect(f.externalWrites).toEqual([]);
  });

  it("persists the accepted request's narrower scope ceiling from an inherited maintainer source", async () => {
    const f = await fixture("local");
    await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
    invalidateOperatorRolePolicy(f.guestProfile);
    const { client, context, session } = await createGitHubPublicationRequesterFixture({
      profileId: f.guestProfile,
      scopes: ["operator.admin"],
      ...f.guestSource.session,
    });
    const source = (await captureGatewayOperatorRunAuthority({ client, context }))!;
    onTestFinished(source.release);
    const captured = await prepareGitHubPublicationRequesterV2(
      {
        client: {
          ...client,
          connect: { ...client.connect, scopes: guestScopes },
          internal: { ...client.internal, operatorRunAuthority: source.authority },
        },
        context,
      },
      session,
    );
    onTestFinished(captured.release);
    expect(source.authority.scopes).toEqual(["operator.admin"]);
    expect(captured.requester.snapshot.scopes).toEqual(guestScopes);
    const claim = await holdWorkerTurn(f);
    const accepted = await request(f, "narrow-requester", captured.requester);
    const stored = f.readRequester(accepted.requestId);
    expect(stored).toEqual({
      version: 1,
      actor: { kind: "operator", profileId: f.guestProfile },
      scopes: guestScopes,
      grant: null,
    });
    captured.release();
    source.release();
    await f.placements.releaseTurn(claim);
    const restarted = await resumePublicationFixture(f);
    await expectResult(restarted, accepted.requestId);
    expect(f.readRequester(accepted.requestId)).toEqual(stored);
    expect(f.publishedTitles).toEqual(["narrow-requester"]);
  });

  it.each(backends)(
    "does not adopt a newly required missing policy for a grant-free %s request",
    async (backend) => {
      const f = await fixture(backend);
      const claim = await holdWorkerTurn(f);
      const guest = await request(f, "before-policy");
      const staff = await request(f, "independent-staff", f.maintainer);
      const original = f.readRequester(guest.requestId);
      expect(original).toEqual(f.guest.snapshot);
      expect(original?.grant).toBeNull();
      expect([guest.status, staff.status]).toEqual(["requested", "requested"]);
      requireVisitorPublicationPolicy(f);
      await f.placements.releaseTurn(claim);
      f.guestSource.release();
      f.maintainerSource.release();
      const restarted = await resumePublicationFixture(f);
      await expectResult(restarted, guest.requestId, identityChanged);
      expect(f.readRequester(guest.requestId)).toEqual(original);
      await expectResult(restarted, staff.requestId);
      expect(f.publishedTitles).toEqual(["independent-staff"]);
    },
  );

  it("captures and resumes from committed config while a tentative restriction is pending", async () => {
    const f = await fixture("local");
    let committed = f.config;
    const restricted = withPublicationGuestRole(f.config, { scopes: [] });
    setRuntimeConfigSnapshot(restricted);
    const getCommittedRuntimeConfig = () => committed;
    const captured = await createGitHubPublicationRequesterFixture({
      profileId: f.guestProfile,
      scopes: guestScopes,
      ...f.guestSource.session,
      getCommittedRuntimeConfig,
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: f.placements,
      getCommittedRuntimeConfig,
    });
    const claim = await holdWorkerTurn(f);
    const tentative = await coordinator.requestForSessionV2(
      f.request("tentative-config", captured.requester),
    );
    expect(tentative.status).toBe("requested");
    await f.placements.releaseTurn(claim);
    await coordinator.resumeSessionRequests();
    await expectResult(coordinator, tentative.requestId);
    const later = await coordinator.requestForSessionV2(
      f.request("committed-config", captured.requester),
    );
    expect(later.status).toBe("requested");
    committed = restricted;
    await coordinator.resumeSessionRequests();
    await expectResult(coordinator, later.requestId, identityChanged);
    expect(f.readRequester(later.requestId)).toEqual(captured.requester.snapshot);
    expect(f.publishedTitles).toEqual(["tentative-config"]);
  });

  it.each(backendCases(["policy unavailable", "alias restored"] as const))(
    "rechecks $backend publication after $change during a preparation read",
    async ({ backend, change }) => {
      const f = await fixture(backend);
      await linkCanonicalUserProfileEmail("publication-secondary@example.test", f.guestProfile);
      const other = await ensureCanonicalUserProfileForEmail(
        "publication-alias-recipient@example.test",
      );
      const visitors = await startVisitorPublicationFixture(f);
      const availability: { restore?: () => void; reached: boolean } = { reached: false };
      try {
        const { original, claim, queued: accepted } = await queueGuest(f, "policy-readiness");
        await f.placements.releaseTurn(claim);
        original.release();
        interceptTransport(async (argv, options, transport) => {
          const result = await transport(argv, options);
          const read =
            (argv[0] === "git" &&
              ["config", "rev-parse", "ls-tree", "symbolic-ref"].some((arg) =>
                argv.includes(arg),
              )) ||
            (argv[0] === "gh" &&
              argv.includes("api") &&
              !argv.includes("POST") &&
              !argv.includes("graphql"));
          if (!availability.reached && read) {
            if (change === "policy unavailable") {
              availability.restore = visitors.suspendRegistry();
            } else {
              await linkCanonicalUserProfileEmail(email, other.id);
              await linkCanonicalUserProfileEmail(email, f.guestProfile);
            }
            availability.reached = true;
          }
          return result;
        });
        const restarted = f.restart();
        const recovery = restarted.resumeSessionRequests();
        if (change === "alias restored") {
          await recovery;
          expect(availability.reached).toBe(true);
          await expectResult(restarted, accepted.requestId, identityChanged);
          expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
          expect(f.externalWrites).toEqual([]);
          return;
        }
        await expect(recovery).rejects.toThrow(new GatewayOperatorAccessUnavailableError().message);
        expect(availability.reached).toBe(true);
        expectPending(f, accepted.requestId);
        expect(f.externalWrites).toEqual([]);
        availability.restore?.();
        availability.restore = undefined;
        await restarted.resumeSessionRequests();
        await expectResult(restarted, accepted.requestId);
        expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
        expect(f.publishedTitles).toEqual(["policy-readiness"]);
      } finally {
        availability.restore?.();
        await visitors.close();
      }
    },
  );

  it.each(["accepted", "response lost"] as const)(
    "settles a local ref/index transaction after requester revocation (%s)",
    async (outcome) => {
      const f = await fixture("local");
      const local = f.local;
      if (!local) {
        throw new Error("Expected the real local publication workspace");
      }
      const originalHead = await local.git("rev-parse", "HEAD");
      let refAccepted = false;
      interceptTransport(async (argv, options, transport) => {
        const result = await transport(argv, options);
        if (!refAccepted && argv.includes("update-ref") && result.code === 0) {
          refAccepted = true;
          await f.revoke();
          if (outcome === "response lost") {
            throw new Error("Synthetic accepted ref response lost");
          }
        }
        return result;
      });
      const idempotencyKey = "revoked-after-local-ref";
      const publishing = request(f, idempotencyKey);
      if (outcome === "response lost") {
        await expect(publishing).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
        await f.restart().resumeSessionRequests();
      } else {
        await expect(publishing).resolves.toMatchObject(identityChanged);
      }
      expect(refAccepted).toBe(true);
      const receipt = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
        sessionId: f.session.sessionId,
        idempotencyKey,
      });
      expect(receipt).toMatchObject({ status: "failed", error_code: "identity_changed" });
      const headCommit = await local.git("rev-parse", "HEAD");
      expect(headCommit).not.toBe(originalHead);
      expect(receipt?.head_commit).toBe(outcome === "accepted" ? headCommit : originalHead);
      expect(await local.git("write-tree")).toBe(await local.git("rev-parse", "HEAD^{tree}"));
      expect(await local.git("show", "HEAD:artifact.txt")).toBe("accepted");
      expect(await local.git("status", "--porcelain")).toBe("");
      const index = nodePath.resolve(
        local.cwd,
        await local.git("rev-parse", "--git-path", "index"),
      );
      expect(
        (await fs.readdir(nodePath.dirname(index))).filter(
          (name) =>
            name === `${nodePath.basename(index)}.lock` ||
            name.startsWith(`${nodePath.basename(index)}.openclaw-`),
        ),
      ).toEqual([]);
      expect(local.effects).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each(backendCases(["direct", "orphaned-claim", "accepted-claim"] as const))(
    "keeps the original requester on $backend $change publication",
    async ({ backend, change }) => {
      const f = await fixture(backend);
      const claim = await holdWorkerTurn(f);
      const guestInput = f.request("guest-publication", f.guest);
      const guest =
        change === "direct"
          ? await f.coordinator.requestForSessionV2(guestInput)
          : await f.coordinator.requestForClaimV2({ ...guestInput, claim });
      const maintainer = await request(f, "maintainer-publication", f.maintainer);
      expect([guest.status, maintainer.status]).toEqual(["requested", "requested"]);
      expect(f.externalWrites).toEqual([]);

      if (change === "accepted-claim") {
        await f.placements.markWorkspaceResultPending(claim);
        await f.coordinator.prepareClaimWorkspace(claim);
        await f.placements.acceptWorkspaceResult(claim);
        await f.revoke();
        await f.coordinator.processClaim(claim);
      } else {
        await f.placements.releaseTurn(claim);
        await f.coordinator.deferOrphanedRequestsAsync();
        await f.revoke();
        await f.restart().resumeSessionRequests();
      }

      await expectResult(f.coordinator, guest.requestId, { status: "failed" });
      await expectResult(f.coordinator, maintainer.requestId, published);
      expect(f.publishedTitles).toEqual(["maintainer-publication"]);
    },
  );

  it.each(backends)(
    "does not rebind a %s receipt when a different operator replays its key",
    async (backend) => {
      const f = await fixture(backend);
      await holdWorkerTurn(f);
      const input = f.request("immutable-requester", f.guest);
      const accepted = await f.coordinator.requestForSessionV2(input);
      const stored = f.readRequester(accepted.requestId);
      expect(stored).toEqual(f.guest.snapshot);
      await expect(
        f.coordinator.requestForSessionV2({ ...input, requester: f.maintainer }),
      ).rejects.toThrow(
        backend === "local"
          ? "GitHub publication requester changed; use a new idempotency key."
          : "GitHub publication idempotency key was reused by a different requester.",
      );
      expect(f.readRequester(accepted.requestId)).toEqual(stored);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each(["renewal", "revoke", "expiry"] as const)(
    "restores only the original Visitor grant after %s and restart",
    async (ending) => {
      const f = await fixture("repository");
      const visitors = await startVisitorPublicationFixture(f);
      try {
        const first = (await visitors.store.lookup(email))!;
        const original = await guestRequester(f);
        const claim = await holdWorkerTurn(f);
        if (ending === "renewal") {
          expect(original.requester.snapshot.grant).toMatchObject({
            pluginId: "visitor-access",
            grantId: first.grantId,
          });
          const accepted = await request(f, "visitor-renewal", original.requester);
          await visitors.execute("visitor_invite", { email, days: 2 });
          const renewed = (await visitors.store.lookup(email))!;
          expect(renewed.grantId).toBe(first.grantId);
          expect(renewed.expiresAt!).toBeGreaterThan(first.expiresAt!);
          expect(original.requester.assertCurrent).not.toThrow();
          await f.placements.releaseTurn(claim);
          original.release();
          await visitors.reopen();
          expect(await visitors.store.lookup(email)).toEqual(renewed);
          const restarted = f.restart();
          await expect(restarted.resumeSessionRequests()).rejects.toBeInstanceOf(AggregateError);
          expectPending(f, accepted.requestId);
          expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
          expect(f.externalWrites).toEqual([]);
          await visitors.start();
          await restarted.resumeSessionRequests();
          await expectResult(restarted, accepted.requestId, published);
          expect(f.publishedTitles).toEqual(["visitor-renewal"]);
          expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
          return;
        }
        const input = f.request("ended-visitor-grant", original.requester);
        const ended = await f.coordinator.requestForSessionV2(input);
        const staff = await request(f, "independent-maintainer", f.maintainer);
        if (ending === "revoke") {
          await visitors.execute("visitor_revoke", { email });
          expect(await visitors.store.lookup(email)).toBeUndefined();
        } else {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(first.expiresAt!);
        }
        expect(original.requester.assertCurrent).toThrow(
          GitHubPublicationRequesterUnavailableError,
        );
        await visitors.execute("visitor_invite", { email, days: 2 });
        const replacement = (await visitors.store.lookup(email))!;
        expect(replacement.grantId).not.toBe(first.grantId);
        vi.useRealTimers();
        const reinvited = await guestRequester(f);
        expect(reinvited.requester.snapshot.grant).toMatchObject({
          pluginId: "visitor-access",
          grantId: replacement.grantId,
        });
        await expect(
          f.coordinator.requestForSessionV2({ ...input, requester: reinvited.requester }),
        ).rejects.toThrow(
          "GitHub publication idempotency key was reused by a different requester.",
        );
        await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
        invalidateOperatorRolePolicy(f.guestProfile);
        expect(original.requester.assertCurrent).toThrow(
          GitHubPublicationRequesterUnavailableError,
        );
        await f.placements.releaseTurn(claim);
        original.release();
        reinvited.release();
        await visitors.reopen();
        await visitors.start();
        const restarted = await resumePublicationFixture(f);
        await expectResult(restarted, ended.requestId, identityChanged);
        expect(f.readRequester(ended.requestId)).toEqual(original.requester.snapshot);
        await expectResult(restarted, staff.requestId, published);
        expect(f.publishedTitles).toEqual(["independent-maintainer"]);
      } finally {
        vi.useRealTimers();
        await visitors.close();
      }
    },
  );

  it.each([
    { backend: "local", change: "ingress released", key: "active-guest" },
    { backend: "repository", change: "ingress released", key: "active-guest" },
    { backend: "local", change: "identity merged", key: "merged-requester" },
    { backend: "local", change: "requester missing", key: "legacy-request" },
    { backend: "repository", change: "requester missing", key: "legacy-request" },
  ] as const)(
    "restores the original $backend requester after $change",
    async ({ backend, change, key }) => {
      const f = await fixture(backend);
      if (change === "ingress released") {
        expect(f.guestSource.client.internal?.operatorAccessAuthority).toBeNull();
        expect(f.guest.snapshot).toEqual({
          version: 1,
          actor: { kind: "operator", profileId: f.guestProfile },
          scopes: guestScopes,
          grant: null,
        });
      }
      const claim = await holdWorkerTurn(f);
      const accepted = await request(f, key);
      if (change === "ingress released") {
        expect(accepted.status).toBe("requested");
        expect(f.readRequester(accepted.requestId)).toEqual(f.guest.snapshot);
        f.guestSource.release();
        expect(f.guest.assertCurrent).toThrow(GitHubPublicationRequesterUnavailableError);
      } else if (change === "identity merged") {
        await linkCanonicalUserProfileEmail(email, f.maintainerProfile);
      } else {
        f.removeRequesterSnapshot(accepted.requestId);
      }
      await f.placements.releaseTurn(claim);
      const restarted = await resumePublicationFixture(f);
      if (change === "ingress released") {
        await expectResult(restarted, accepted.requestId, published);
        expect(f.publishedTitles).toEqual([key]);
      } else {
        await expectResult(restarted, accepted.requestId, { status: "failed" });
        expect(f.externalWrites).toEqual([]);
        if (change === "requester missing") {
          const fresh = await request(f, "fresh-request", f.maintainer);
          expect(fresh.status).toBe(backend === "local" ? "requested" : "published");
          await f.coordinator.resumeSessionRequests();
          await expectResult(f.coordinator, fresh.requestId);
          expect(f.publishedTitles).toEqual(["fresh-request"]);
        }
      }
    },
  );

  it.each(backendCases(["push", "pull_request"] as const))(
    "retains an accepted $backend $change response when its requester is revoked in flight",
    async ({ backend, change: effect }) => {
      const f = await fixture(backend);
      const local = f.local;
      interceptTransport(async (argv, options, transport) => {
        const result = await transport(argv, options);
        if (
          effect === "push"
            ? argv.includes("push") || argv.includes("graphql")
            : argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"))
        ) {
          await f.revoke();
        }
        return result;
      });
      const result = await request(f, "late-pr-response");
      const receipt = f.readReceipt(result.requestId)!;
      if (effect === "push") {
        expect(result).toMatchObject(identityChanged);
        expect(receipt).toMatchObject({
          head_commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
          pull_request_url: null,
        });
        if (backend === "repository") {
          expect(readRepositoryGitHubPublication(result.requestId)).toMatchObject({
            pushed_head_commit: receipt.head_commit,
            last_effect: "push",
            effect_state: "observed",
          });
        }
      } else {
        expect(result.status).toBe("published");
        expect(receipt.pull_request_url).toBe(publicationUrl(backend));
      }
      const writes = [...f.externalWrites];
      const acceptedEffects = local && [...local.effects];
      await f.restart().resumeSessionRequests();
      expect(f.externalWrites).toEqual(writes);
      if (local) {
        expect(local.effects).toEqual(acceptedEffects);
        expect(local.effects).toEqual(effect === "push" ? ["push"] : ["push", "pull_request"]);
      }
      expect(f.publishedTitles).toEqual(effect === "push" ? [] : ["late-pr-response"]);
    },
  );

  it.each(backends)(
    "preserves terminal %s receipts after removal of legacy requester metadata",
    async (backend) => {
      const f = await fixture(backend);
      const publication = await f.coordinator.requestForSessionV2(f.request("complete", f.guest));
      expect(publication.status).toBe("published");
      const writes = [...f.externalWrites];
      f.removeRequesterSnapshot(publication.requestId);
      await f.revoke();
      const restarted = await resumePublicationFixture(f);
      expect(await restarted.readAsync(publication.requestId)).toEqual(publication);
      expect(f.externalWrites).toEqual(writes);
    },
  );

  it.each([
    "accepted",
    "advanced-closed",
    "unrelated",
    "ancestry-unavailable",
    "unmarked",
    "old-tree",
    "wrong-marker",
    "missing",
    "unavailable",
  ] as const)(
    "only observes an interrupted local publication with an %s remote result",
    async (outcome) => {
      await persistPublicationTestSession();
      await createRealPublicationWorkspace();
      const database = openOpenClawStateDatabase();
      const requestId = "legacy-interrupted-publication";
      const advancedHead = "f".repeat(40);
      const is = (...values: (typeof outcome)[]) => values.includes(outcome);
      const advanced = is("advanced-closed", "unrelated", "ancestry-unavailable", "unmarked");
      const commitPath = `repos/openclaw/openclaw/git/commits/${NEW_HEAD}`;
      const comparePath = `repos/openclaw/openclaw/compare/${NEW_HEAD}...${advancedHead}?per_page=1`;
      const reads = new Set<string>();
      const replies = [
        [
          comparePath,
          is("ancestry-unavailable")
            ? commandResult("", 1)
            : jsonResult({ sha: is("unrelated") ? OLD_HEAD : NEW_HEAD }),
        ],
        [
          commitPath,
          is("unavailable")
            ? commandResult("", 1)
            : jsonResult({
                sha: NEW_HEAD,
                tree: { sha: is("old-tree") ? "e".repeat(40) : WORKSPACE_TREE },
                parents: [{ sha: OLD_HEAD }],
                message: `OpenClaw-Publication: ${is("wrong-marker") ? "another-request" : requestId}`,
              }),
        ],
        [
          "state=all",
          jsonResult(
            is("missing")
              ? []
              : [
                  pullRequest({
                    state: is("advanced-closed") ? "closed" : "open",
                    body: is("unmarked")
                      ? "Another publication"
                      : `<!-- openclaw-publication:${requestId} -->`,
                    headSha: advanced ? advancedHead : NEW_HEAD,
                  }),
                ],
          ),
        ],
      ] as const;
      seedLocalPublication(database, { requestId, status: "publishing", requester: null });
      interceptTransport(async (argv, options, transport) => {
        const reply = replies.find(([endpoint]) => argv.includes(endpoint));
        if (!reply) {
          return await transport(argv, options);
        }
        reads.add(reply[0]);
        return reply[1];
      });
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
      const recovery = coordinator.resumeSessionRequests();
      if (is("missing", "unavailable", "unrelated", "ancestry-unavailable", "unmarked")) {
        await expect(recovery).rejects.toBeInstanceOf(AggregateError);
        expect(["requested", "publishing"]).toContain(
          (await coordinator.readAsync(requestId))?.status,
        );
      } else {
        await recovery;
      }
      if (is("accepted", "advanced-closed")) {
        await expectResult(coordinator, requestId, {
          status: "published",
          url: publicationUrl("local"),
          headCommit: NEW_HEAD,
        });
      } else {
        expect((await coordinator.readAsync(requestId))?.status).not.toBe("published");
        expect(readGitHubPublicationRequest(database.db, { requestId })).toMatchObject({
          head_commit: NEW_HEAD,
          workspace_tree: WORKSPACE_TREE,
        });
      }
      if (advanced && !is("unmarked")) {
        expect(reads.has(comparePath)).toBe(true);
      }
      expect(reads.has(commitPath)).toBe(true);
      if (!is("unavailable", "old-tree", "wrong-marker")) {
        expect(reads.has("state=all")).toBe(true);
      }
      expect(
        mocks.runCommand.mock.calls.some(
          ([argv]) => argv.includes("push") || argv.includes("POST"),
        ),
      ).toBe(false);
    },
  );

  it.each(backends)(
    "keeps an accepted %s PR recoverable after revocation and an unavailable readback",
    async (backend) => {
      const f = await fixture(backend);
      const local = f.local;
      const writes: string[][] = [];
      let responseLost = false;
      let readbackAvailable = false;
      let unavailableReads = 0;
      let localAccepted: ReturnType<typeof pullRequest> | undefined;
      interceptTransport(async (argv, options, transport) => {
        if (
          argv.includes("push") ||
          argv.some((arg) => ["POST", "PUT", "PATCH", "DELETE", "graphql"].includes(arg))
        ) {
          writes.push([...argv]);
        }
        const commitRead = argv.find((arg) => arg.includes("/git/commits/"));
        if (responseLost && commitRead && !readbackAvailable) {
          unavailableReads += 1;
          return commandResult("", 1);
        }
        if (localAccepted && argv.includes("state=all")) {
          return jsonResult([localAccepted]);
        }
        const result = await transport(argv, options);
        if (argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"))) {
          if (local) {
            const payload = JSON.parse(options!.input!);
            localAccepted = pullRequest({
              headSha: await local.git("rev-parse", "HEAD"),
              body: payload.body,
              baseRef: payload.base,
              url: JSON.parse(result.stdout.toString("utf8")).html_url,
            });
          }
          responseLost = true;
          throw new Error("Synthetic lost PR response");
        }
        return result;
      });
      const idempotencyKey = "lost-pr-response";
      const publication = request(f, idempotencyKey);
      let requestId: string;
      if (backend === "local") {
        await expect(publication).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
        requestId = readGitHubPublicationRequest(f.database.db, {
          sessionId: f.session.sessionId,
          idempotencyKey,
        })!.request_id;
      } else {
        const accepted = await publication;
        expect(accepted.status).toBe("requested");
        requestId = accepted.requestId;
      }
      expect(responseLost).toBe(true);
      expect(f.readReceipt(requestId)?.pull_request_url).toBeNull();
      const acceptedWrites = [...writes];
      await f.revoke();
      expect(f.guest.assertCurrent).toThrow();
      const restarted = f.restart();
      const readsBeforeRecovery = unavailableReads;
      await expect(restarted.resumeSessionRequests()).rejects.toBeInstanceOf(AggregateError);
      const pending = f.readReceipt(requestId)!;
      expectPending(f, requestId);
      expect(pending.pull_request_url).toBeNull();
      expect(unavailableReads).toBeGreaterThan(readsBeforeRecovery);
      expect(writes).toEqual(acceptedWrites);

      readbackAvailable = true;
      await restarted.resumeSessionRequests();
      await expectResult(restarted, requestId, {
        status: "published",
        url: publicationUrl(backend),
      });
      expect(writes).toEqual(acceptedWrites);
      expect(f.publishedTitles).toEqual(["lost-pr-response"]);
    },
  );
});
