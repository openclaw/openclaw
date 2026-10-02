// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  WORKSPACE_TREE,
  commandResult,
  createGitHubPublicationRequesterFixture,
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
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { captureGitHubPublicationRequester } from "./github-publication-requester.js";
import {
  createRequesterPolicyFixture,
  createRequesterPublicationFixture,
  guestScopes,
  publisherScopes,
  holdWorkerTurn,
  preparePublisherAccessPolicyFixture,
  requirePublisherAccessPolicy,
} from "./github-publication-requester.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.js";
import { readRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import {
  GatewayOperatorAccessUnavailableError,
  hasGatewayOperatorAccessPolicies,
} from "./operator-access-policy.js";
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

describe("shared GitHub publication requester authority", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    realWorktree: true,
  });

  it("retains and releases a reviewed requester whose inherited authority has no signal", async () => {
    const f = await createRequesterPolicyFixture();
    const { client, context, session } = f.publisherSource;
    const source = (await captureGatewayOperatorRunAuthority({ client, context }))!;
    onTestFinished(source.release);
    const authority = createAdmittedRunOperatorAuthority({
      ...source.authority,
      signal: undefined,
    });
    const captured = await captureGitHubPublicationRequester(
      {
        client: { ...client, internal: { ...client.internal, operatorRunAuthority: authority } },
        context,
      },
      session,
    );
    onTestFinished(captured.release);
    const retained = captured.requester.retainForReview!();
    try {
      captured.release();
      expect(retained.requester.assertCurrent).not.toThrow();
      expect(retained.signal.aborted).toBe(false);
      retained.release();
      expect(retained.signal.aborted).toBe(true);
      expect(retained.requester.assertCurrent).toThrow();
    } finally {
      retained.release();
    }
  });

  it("does not inherit maintainer publication authority through a narrow invocation", async () => {
    const f = await createRequesterPolicyFixture();
    const { client, context, session } = f.maintainerSource;
    const source = (await captureGatewayOperatorRunAuthority({ client, context }))!;
    onTestFinished(source.release);
    await expect(
      captureGitHubPublicationRequester(
        {
          client: {
            ...client,
            connect: { ...client.connect, scopes: guestScopes },
            internal: { ...client.internal, operatorRunAuthority: source.authority },
          },
          context,
        },
        session,
      ),
    ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
    expect(f.externalWrites).toEqual([]);
  });

  it.each(["local", "repository"] as const)(
    "does not promote a stored narrow %s request and admits a fresh maintainer request in the same guest thread",
    async (backend) => {
      const f = await fixture(backend);
      const claim = await holdWorkerTurn(f);
      const accepted = await f.coordinator.requestForSession(
        f.request("old-narrow-request", f.publisher),
      );
      // Model a pre-upgrade persisted request; current admission cannot create this authority.
      const narrow = {
        ...f.publisher.snapshot,
        actor: { kind: "operator" as const, profileId: f.guestProfile },
        scopes: guestScopes,
      };
      f.replaceRequesterSnapshot(accepted.requestId, narrow);
      await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
      invalidateOperatorRolePolicy(f.guestProfile);
      await f.placements.releaseTurn(claim);
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(restarted.read(accepted.requestId)).toMatchObject({
        status: "failed",
        code: "identity_changed",
      });
      expect(f.readRequester(accepted.requestId)).toEqual(narrow);
      expect(f.externalWrites).toEqual([]);
      const fresh = await restarted.requestForSession(
        f.request("fresh-maintainer-request", f.maintainer),
      );
      await restarted.resumeSessionRequests();
      expect(restarted.read(fresh.requestId)).toMatchObject({ status: "published" });
      expect(f.readRequester(fresh.requestId)).toEqual(f.maintainer.snapshot);
      expect(f.publishedTitles).toEqual(["fresh-maintainer-request"]);
    },
  );

  it("distinguishes explicit System authority from missing, unclassified, and closed sources", async () => {
    const f = await createRequesterPolicyFixture();
    const { context, session } = f.publisherSource;
    const system = await captureGitHubPublicationRequester(
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
      ["unclassified", { ...f.publisherSource.client, internal: undefined }],
    ] as const) {
      await expect(
        captureGitHubPublicationRequester({ client, context }, session),
        label,
      ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
    }
    const source = (await captureGatewayOperatorRunAuthority({
      client: f.publisherSource.client,
      context,
    }))!;
    source.release();
    await expect(
      captureGitHubPublicationRequester(
        {
          client: {
            ...f.publisherSource.client,
            internal: {
              ...f.publisherSource.client.internal,
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

  it("persists the accepted request's narrower scope ceiling from an inherited maintainer source", async () => {
    const f = await fixture("local");
    await setCanonicalUserProfileRole(f.publisherProfile, "maintainer");
    invalidateOperatorRolePolicy(f.publisherProfile);
    const { client, context, session } = await createGitHubPublicationRequesterFixture({
      profileId: f.publisherProfile,
      scopes: ["operator.admin"],
      ...f.publisherSource.session,
    });
    const source = (await captureGatewayOperatorRunAuthority({ client, context }))!;
    onTestFinished(source.release);
    const captured = await captureGitHubPublicationRequester(
      {
        client: {
          ...client,
          connect: { ...client.connect, scopes: publisherScopes },
          internal: { ...client.internal, operatorRunAuthority: source.authority },
        },
        context,
      },
      session,
    );
    onTestFinished(captured.release);
    expect(source.authority.scopes).toEqual(["operator.admin"]);
    expect(captured.requester.snapshot.scopes).toEqual(publisherScopes);
    const claim = await holdWorkerTurn(f);
    const accepted = await f.coordinator.requestForSession(
      f.request("narrow-requester", captured.requester),
    );
    const stored = f.readRequester(accepted.requestId);
    expect(stored).toEqual({
      version: 1,
      actor: { kind: "operator", profileId: f.publisherProfile },
      scopes: publisherScopes,
      grant: null,
    });
    captured.release();
    source.release();
    await f.placements.releaseTurn(claim);
    const restarted = f.restart();
    await restarted.resumeSessionRequests();
    expect(restarted.read(accepted.requestId)).toMatchObject({ status: "published" });
    expect(f.readRequester(accepted.requestId)).toEqual(stored);
    expect(f.publishedTitles).toEqual(["narrow-requester"]);
  });

  it.each(["local", "repository"] as const)(
    "does not adopt a newly required missing policy for a grant-free %s request",
    async (backend) => {
      const f = await fixture(backend);
      expect(hasGatewayOperatorAccessPolicies(f.config)).toBe(false);
      const claim = await holdWorkerTurn(f);
      const publisher = await f.coordinator.requestForSession(
        f.request("before-policy", f.publisher),
      );
      const staff = await f.coordinator.requestForSession(
        f.request("independent-staff", f.maintainer),
      );
      const original = f.readRequester(publisher.requestId);
      expect(original).toEqual(f.publisher.snapshot);
      expect(original?.grant).toBeNull();
      expect(publisher.status).toBe("requested");
      expect(staff.status).toBe("requested");
      const requiredConfig = requirePublisherAccessPolicy(f);
      expect(hasGatewayOperatorAccessPolicies(requiredConfig)).toBe(true);
      expect(getPluginRegistryState()?.activeRegistry?.gatewayAccessPolicies ?? []).toEqual([]);
      await f.placements.releaseTurn(claim);
      f.publisherSource.release();
      f.maintainerSource.release();
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(restarted.read(publisher.requestId)).toMatchObject({
        status: "failed",
        code: "identity_changed",
      });
      expect(f.readRequester(publisher.requestId)).toEqual(original);
      expect(restarted.read(staff.requestId)).toMatchObject({ status: "published" });
      expect(f.publishedTitles).toEqual(["independent-staff"]);
    },
  );

  it("captures and resumes from committed config while a tentative restriction is pending", async () => {
    const f = await fixture("local");
    let committed = f.config;
    const roles = f.config.gateway!.roles!;
    const restricted: typeof f.config = {
      ...f.config,
      gateway: {
        ...f.config.gateway,
        roles: {
          ...roles,
          definitions: {
            ...roles.definitions,
            publisher: { ...roles.definitions.publisher!, scopes: [] },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(restricted);
    const getCommittedRuntimeConfig = () => committed;
    const captured = await createGitHubPublicationRequesterFixture({
      profileId: f.publisherProfile,
      scopes: publisherScopes,
      ...f.publisherSource.session,
      getCommittedRuntimeConfig,
    });
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: f.placements,
      getCommittedRuntimeConfig,
    });
    const claim = await holdWorkerTurn(f);
    const tentative = await coordinator.requestForSession(
      f.request("tentative-config", captured.requester),
    );
    expect(tentative.status).toBe("requested");
    await f.placements.releaseTurn(claim);
    await coordinator.resumeSessionRequests();
    expect(coordinator.read(tentative.requestId)).toMatchObject({ status: "published" });
    const later = await coordinator.requestForSession(
      f.request("committed-config", captured.requester),
    );
    expect(later.status).toBe("requested");
    committed = restricted;
    await coordinator.resumeSessionRequests();
    expect(coordinator.read(later.requestId)).toMatchObject({
      status: "failed",
      code: "identity_changed",
    });
    expect(f.readRequester(later.requestId)).toEqual(captured.requester.snapshot);
    expect(f.publishedTitles).toEqual(["tentative-config"]);
  });

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      (["policy unavailable", "alias restored"] as const).map((change) => ({ backend, change })),
    ),
  )(
    "rechecks $backend publication after $change during a preparation read",
    async ({ backend, change }) => {
      const f = await fixture(backend);
      const email = "publication-publisher@example.test";
      await linkCanonicalUserProfileEmail("publication-secondary@example.test", f.publisherProfile);
      const other = await ensureCanonicalUserProfileForEmail(
        "publication-alias-recipient@example.test",
      );
      const visitors = await preparePublisherAccessPolicyFixture(f);
      const availability: { restore?: () => void; reached: boolean } = { reached: false };
      try {
        await visitors.start();
        await visitors.execute("grant", {
          email,
          days: 1,
        });
        const original = await createGitHubPublicationRequesterFixture({
          profileId: f.publisherProfile,
          scopes: publisherScopes,
          ...f.publisherSource.session,
        });
        const claim = await holdWorkerTurn(f);
        const accepted = await f.coordinator.requestForSession(
          f.request("policy-readiness", original.requester),
        );
        expect(accepted.status).toBe("requested");
        await f.placements.releaseTurn(claim);
        original.release();
        const transport = mocks.runCommand.getMockImplementation()!;
        mocks.runCommand.mockImplementation(
          async (argv: string[], options?: { input?: string }) => {
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
                await linkCanonicalUserProfileEmail(email, f.publisherProfile);
              }
              availability.reached = true;
            }
            return result;
          },
        );
        const restarted = f.restart();
        const recovery = restarted.resumeSessionRequests();
        if (change === "alias restored") {
          await recovery;
          expect(availability.reached).toBe(true);
          expect(restarted.read(accepted.requestId)).toMatchObject({
            status: "failed",
            code: "identity_changed",
          });
          expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
          expect(f.externalWrites).toEqual([]);
          return;
        }
        await expect(recovery).rejects.toThrow(new GatewayOperatorAccessUnavailableError().message);
        expect(availability.reached).toBe(true);
        expect(["requested", "publishing"]).toContain(f.readReceipt(accepted.requestId)?.status);
        expect(f.readReceipt(accepted.requestId)?.error_code).toBeNull();
        expect(f.externalWrites).toEqual([]);
        availability.restore?.();
        availability.restore = undefined;
        await restarted.resumeSessionRequests();
        expect(restarted.read(accepted.requestId)).toMatchObject({ status: "published" });
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
      const transport = mocks.runCommand.getMockImplementation()!;
      let refAccepted = false;
      mocks.runCommand.mockImplementation(async (argv, options) => {
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
      const publishing = f.coordinator.requestForSession(f.request(idempotencyKey, f.publisher));
      if (outcome === "response lost") {
        await expect(publishing).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
        await f.restart().resumeSessionRequests();
      } else {
        await expect(publishing).resolves.toMatchObject({
          status: "failed",
          code: "identity_changed",
        });
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

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      (["direct", "orphaned-claim", "accepted-claim"] as const).map((path) => ({ backend, path })),
    ),
  )("keeps the original requester on $backend $path publication", async ({ backend, path }) => {
    const f = await fixture(backend);
    const claim = await holdWorkerTurn(f);
    const publisherInput = f.request("publisher-publication", f.publisher);
    const publisher =
      path === "direct"
        ? await f.coordinator.requestForSession(publisherInput)
        : await f.coordinator.requestForClaim({ ...publisherInput, claim });
    const maintainer = await f.coordinator.requestForSession(
      f.request("maintainer-publication", f.maintainer),
    );
    expect(publisher.status).toBe("requested");
    expect(maintainer.status).toBe("requested");
    expect(f.externalWrites).toEqual([]);

    if (path === "accepted-claim") {
      f.placements.markWorkspaceResultPending(claim);
      await f.coordinator.prepareClaimWorkspace(claim);
      f.placements.acceptWorkspaceResult(claim);
      await f.revoke();
      await f.coordinator.processClaim(claim);
    } else {
      await f.placements.releaseTurn(claim);
      f.coordinator.deferOrphanedRequests();
      await f.revoke();
      await f.restart().resumeSessionRequests();
    }

    expect(f.coordinator.read(publisher.requestId)).toMatchObject({ status: "failed" });
    expect(f.coordinator.read(maintainer.requestId)).toMatchObject({
      status: "published",
      publisher: { accountId: 42, login: "roboclaw-bot" },
    });
    expect(f.publishedTitles).toEqual(["maintainer-publication"]);
  });

  it.each(["local", "repository"] as const)(
    "does not rebind a %s receipt when a different operator replays its key",
    async (backend) => {
      const f = await fixture(backend);
      await holdWorkerTurn(f);
      const input = f.request("immutable-requester", f.publisher);
      const accepted = await f.coordinator.requestForSession(input);
      const stored = f.readRequester(accepted.requestId);
      expect(stored).toEqual(f.publisher.snapshot);
      await expect(
        f.coordinator.requestForSession({ ...input, requester: f.maintainer }),
      ).rejects.toThrow(
        backend === "local"
          ? "GitHub publication requester changed; use a new idempotency key."
          : "GitHub publication idempotency key was reused by a different requester.",
      );
      expect(f.readRequester(accepted.requestId)).toEqual(stored);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("retains a renewed publisher access grant across a store reopen and waits for plugin readiness", async () => {
    const f = await fixture("repository");
    const visitors = await preparePublisherAccessPolicyFixture(f);
    try {
      await visitors.start();
      const email = "publication-publisher@example.test";
      await visitors.execute("grant", { email, days: 1 });
      const first = (await visitors.store.lookup(email))!;
      const original = await createGitHubPublicationRequesterFixture({
        profileId: f.publisherProfile,
        scopes: publisherScopes,
        ...f.publisherSource.session,
      });
      expect(original.requester.snapshot.grant).toMatchObject({
        pluginId: "publication-access",
        grantId: first.grantId,
      });
      const claim = await holdWorkerTurn(f);
      const accepted = await f.coordinator.requestForSession(
        f.request("visitor-renewal", original.requester),
      );
      await visitors.execute("grant", { email, days: 2 });
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
      expect(["requested", "publishing"]).toContain(f.readReceipt(accepted.requestId)?.status);
      expect(f.readReceipt(accepted.requestId)?.error_code).toBeNull();
      expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
      expect(f.externalWrites).toEqual([]);
      await visitors.start();
      await restarted.resumeSessionRequests();
      expect(restarted.read(accepted.requestId)).toMatchObject({
        status: "published",
        publisher: { accountId: 42, login: "roboclaw-bot" },
      });
      expect(f.publishedTitles).toEqual(["visitor-renewal"]);
      expect(f.readRequester(accepted.requestId)).toEqual(original.requester.snapshot);
    } finally {
      await visitors.close();
    }
  });

  it.each(["revoke", "expiry"] as const)(
    "cannot revive the original publisher access request after %s, reinvitation, promotion, and restart",
    async (ending) => {
      const f = await fixture("repository");
      const visitors = await preparePublisherAccessPolicyFixture(f);
      try {
        await visitors.start();
        const email = "publication-publisher@example.test";
        await visitors.execute("grant", { email, days: 1 });
        const first = (await visitors.store.lookup(email))!;
        const original = await createGitHubPublicationRequesterFixture({
          profileId: f.publisherProfile,
          scopes: publisherScopes,
          ...f.publisherSource.session,
        });
        const claim = await holdWorkerTurn(f);
        const input = f.request("ended-visitor-grant", original.requester);
        const ended = await f.coordinator.requestForSession(input);
        const staff = await f.coordinator.requestForSession(
          f.request("independent-maintainer", f.maintainer),
        );
        if (ending === "revoke") {
          await visitors.execute("revoke", { email });
          expect(await visitors.store.lookup(email)).toBeUndefined();
        } else {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(first.expiresAt!);
        }
        expect(original.requester.assertCurrent).toThrow(
          GitHubPublicationRequesterUnavailableError,
        );
        await visitors.execute("grant", { email, days: 2 });
        const replacement = (await visitors.store.lookup(email))!;
        expect(replacement.grantId).not.toBe(first.grantId);
        vi.useRealTimers();
        const reinvited = await createGitHubPublicationRequesterFixture({
          profileId: f.publisherProfile,
          scopes: publisherScopes,
          ...f.publisherSource.session,
        });
        expect(reinvited.requester.snapshot.grant).toMatchObject({
          pluginId: "publication-access",
          grantId: replacement.grantId,
        });
        await expect(
          f.coordinator.requestForSession({ ...input, requester: reinvited.requester }),
        ).rejects.toThrow(
          "GitHub publication idempotency key was reused by a different requester.",
        );
        await setCanonicalUserProfileRole(f.publisherProfile, "maintainer");
        invalidateOperatorRolePolicy(f.publisherProfile);
        expect(original.requester.assertCurrent).toThrow(
          GitHubPublicationRequesterUnavailableError,
        );
        await f.placements.releaseTurn(claim);
        original.release();
        reinvited.release();
        await visitors.reopen();
        await visitors.start();
        const restarted = f.restart();
        await restarted.resumeSessionRequests();
        expect(restarted.read(ended.requestId)).toMatchObject({
          status: "failed",
          code: "identity_changed",
        });
        expect(f.readRequester(ended.requestId)).toEqual(original.requester.snapshot);
        expect(restarted.read(staff.requestId)).toMatchObject({
          status: "published",
          publisher: { accountId: 42, login: "roboclaw-bot" },
        });
        expect(f.publishedTitles).toEqual(["independent-maintainer"]);
      } finally {
        vi.useRealTimers();
        await visitors.close();
      }
    },
  );

  it.each(["local", "repository"] as const)(
    "resumes the recorded %s requester after its original ingress source is released",
    async (backend) => {
      const f = await fixture(backend);
      expect(f.publisherSource.client.internal?.operatorAccessAuthority).toBeNull();
      expect(f.publisher.snapshot).toEqual({
        version: 1,
        actor: { kind: "operator", profileId: f.publisherProfile },
        scopes: publisherScopes,
        grant: null,
      });
      const claim = await holdWorkerTurn(f);
      const accepted = await f.coordinator.requestForSession(
        f.request("active-publisher", f.publisher),
      );
      expect(accepted.status).toBe("requested");
      expect(f.readRequester(accepted.requestId)).toEqual(f.publisher.snapshot);
      f.publisherSource.release();
      expect(f.publisher.assertCurrent).toThrow(GitHubPublicationRequesterUnavailableError);
      await f.placements.releaseTurn(claim);
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(restarted.read(accepted.requestId)).toMatchObject({
        status: "published",
        publisher: { accountId: 42, login: "roboclaw-bot" },
      });
      expect(f.publishedTitles).toEqual(["active-publisher"]);
    },
  );

  it("does not adopt a merged requester's maintainer identity on restart", async () => {
    const f = await fixture("local");
    const claim = await holdWorkerTurn(f);
    const accepted = await f.coordinator.requestForSession(
      f.request("merged-requester", f.publisher),
    );
    await linkCanonicalUserProfileEmail("publication-publisher@example.test", f.maintainerProfile);
    await f.placements.releaseTurn(claim);
    const restarted = f.restart();
    await restarted.resumeSessionRequests();
    expect(restarted.read(accepted.requestId)).toMatchObject({ status: "failed" });
    expect(f.externalWrites).toEqual([]);
  });

  it.each(["local", "repository"] as const)(
    "requires fresh admission for a %s request with no original requester",
    async (backend) => {
      const f = await fixture(backend);
      const claim = await holdWorkerTurn(f);
      const legacy = await f.coordinator.requestForSession(
        f.request("legacy-request", f.publisher),
      );
      f.removeRequesterSnapshot(legacy.requestId);
      await f.placements.releaseTurn(claim);
      await f.restart().resumeSessionRequests();
      expect(f.coordinator.read(legacy.requestId)).toMatchObject({ status: "failed" });
      expect(f.externalWrites).toEqual([]);
      const fresh = await f.coordinator.requestForSession(f.request("fresh-request", f.maintainer));
      expect(fresh.status).toBe(backend === "local" ? "requested" : "published");
      await f.coordinator.resumeSessionRequests();
      expect(f.coordinator.read(fresh.requestId)).toMatchObject({ status: "published" });
      expect(f.publishedTitles).toEqual(["fresh-request"]);
    },
  );

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      (["push", "pull_request"] as const).map((effect) => ({ backend, effect })),
    ),
  )(
    "retains an accepted $backend $effect response when its requester is revoked in flight",
    async ({ backend, effect }) => {
      const f = await fixture(backend);
      const local = f.local;
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
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
      const result = await f.coordinator.requestForSession(
        f.request("late-pr-response", f.publisher),
      );
      const receipt = f.readReceipt(result.requestId)!;
      if (effect === "push") {
        expect(result).toMatchObject({ status: "failed", code: "identity_changed" });
        expect(receipt.head_commit).toMatch(/^[a-f0-9]{40}$/u);
        expect(receipt.pull_request_url).toBeNull();
        if (backend === "repository") {
          expect(readRepositoryGitHubPublication(result.requestId)).toMatchObject({
            pushed_head_commit: receipt.head_commit,
            last_effect: "push",
            effect_state: "observed",
          });
        }
      } else {
        expect(result.status).toBe("published");
        expect(receipt.pull_request_url).toBe(
          backend === "repository"
            ? "https://github.com/owner/repository/pull/1"
            : "https://github.com/openclaw/openclaw/pull/125200",
        );
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

  it.each(["local", "repository"] as const)(
    "preserves terminal %s receipts after removal of legacy requester metadata",
    async (backend) => {
      const f = await fixture(backend);
      const published = await f.coordinator.requestForSession(f.request("complete", f.publisher));
      expect(published.status).toBe("published");
      const writes = [...f.externalWrites];
      f.removeRequesterSnapshot(published.requestId);
      await f.revoke();
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(restarted.read(published.requestId)).toEqual(published);
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
      const advanced = [
        "advanced-closed",
        "unrelated",
        "ancestry-unavailable",
        "unmarked",
      ].includes(outcome);
      let compared = false;
      let readCommit = false;
      let readPullRequests = false;
      seedLocalPublication(database, { requestId, status: "publishing", requester: null });
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (
          argv.includes(
            "repos/openclaw/openclaw/compare/" + NEW_HEAD + "..." + advancedHead + "?per_page=1",
          )
        ) {
          compared = true;
          return outcome === "ancestry-unavailable"
            ? commandResult("", 1)
            : commandResult(JSON.stringify({ sha: outcome === "unrelated" ? OLD_HEAD : NEW_HEAD }));
        }
        if (argv.includes(`repos/openclaw/openclaw/git/commits/${NEW_HEAD}`)) {
          readCommit = true;
          return outcome === "unavailable"
            ? commandResult("", 1)
            : commandResult(
                JSON.stringify({
                  sha: NEW_HEAD,
                  tree: { sha: outcome === "old-tree" ? "e".repeat(40) : WORKSPACE_TREE },
                  parents: [{ sha: OLD_HEAD }],
                  message: `OpenClaw-Publication: ${outcome === "wrong-marker" ? "another-request" : requestId}`,
                }),
              );
        }
        if (argv.includes("state=all")) {
          readPullRequests = true;
          return commandResult(
            JSON.stringify(
              outcome === "missing"
                ? []
                : [
                    {
                      url: "https://github.com/openclaw/openclaw/pull/125200",
                      userId: 42,
                      state: outcome === "advanced-closed" ? "closed" : "open",
                      body:
                        outcome === "unmarked"
                          ? "Another publication"
                          : `<!-- openclaw-publication:${requestId} -->`,
                      headSha: advanced ? advancedHead : NEW_HEAD,
                      headRef: BRANCH,
                      baseRef: "main",
                    },
                  ],
            ),
          );
        }
        return await transport(argv, options);
      });
      const coordinator = createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database }),
      });
      const recovery = coordinator.resumeSessionRequests();
      if (
        ["missing", "unavailable", "unrelated", "ancestry-unavailable", "unmarked"].includes(
          outcome,
        )
      ) {
        await expect(recovery).rejects.toBeInstanceOf(AggregateError);
        expect(["requested", "publishing"]).toContain(coordinator.read(requestId)?.status);
      } else {
        await recovery;
      }
      if (outcome === "accepted" || outcome === "advanced-closed") {
        expect(coordinator.read(requestId)).toMatchObject({
          status: "published",
          url: "https://github.com/openclaw/openclaw/pull/125200",
          headCommit: NEW_HEAD,
        });
      } else {
        expect(coordinator.read(requestId)?.status).not.toBe("published");
        expect(readGitHubPublicationRequest(database.db, { requestId })).toMatchObject({
          head_commit: NEW_HEAD,
          workspace_tree: WORKSPACE_TREE,
        });
      }
      if (advanced && outcome !== "unmarked") {
        expect(compared).toBe(true);
      }
      expect(readCommit).toBe(true);
      if (!["unavailable", "old-tree", "wrong-marker"].includes(outcome)) {
        expect(readPullRequests).toBe(true);
      }
      expect(
        mocks.runCommand.mock.calls.some(
          ([argv]) => argv.includes("push") || argv.includes("POST"),
        ),
      ).toBe(false);
    },
  );

  it.each(["local", "repository"] as const)(
    "keeps an accepted %s PR recoverable after revocation and an unavailable readback",
    async (backend) => {
      const f = await fixture(backend);
      const local = f.local;
      const transport = mocks.runCommand.getMockImplementation()!;
      const writes: string[][] = [];
      let responseLost = false;
      let readbackAvailable = false;
      let unavailableReads = 0;
      let localAccepted:
        | {
            head: string;
            body: string;
            base: string;
            url: string;
          }
        | undefined;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
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
          return commandResult(
            JSON.stringify([
              {
                url: localAccepted.url,
                userId: 42,
                state: "open",
                body: localAccepted.body,
                headSha: localAccepted.head,
                headRef: BRANCH,
                baseRef: localAccepted.base,
              },
            ]),
          );
        }
        const result = await transport(argv, options);
        if (argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"))) {
          if (local) {
            const request = JSON.parse(options!.input!);
            localAccepted = {
              head: await local.git("rev-parse", "HEAD"),
              body: request.body,
              base: request.base,
              url: JSON.parse(result.stdout.toString("utf8")).html_url,
            };
          }
          responseLost = true;
          throw new Error("Synthetic lost PR response");
        }
        return result;
      });
      const idempotencyKey = "lost-pr-response";
      const publication = f.coordinator.requestForSession(f.request(idempotencyKey, f.publisher));
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
      expect(f.publisher.assertCurrent).toThrow();
      const restarted = f.restart();
      const readsBeforeRecovery = unavailableReads;
      await expect(restarted.resumeSessionRequests()).rejects.toBeInstanceOf(AggregateError);
      const pending = f.readReceipt(requestId)!;
      expect(["requested", "publishing"]).toContain(pending.status);
      expect(pending.error_code).toBeNull();
      expect(pending.pull_request_url).toBeNull();
      expect(unavailableReads).toBeGreaterThan(readsBeforeRecovery);
      expect(writes).toEqual(acceptedWrites);

      readbackAvailable = true;
      await restarted.resumeSessionRequests();
      expect(restarted.read(requestId)).toMatchObject({
        status: "published",
        url:
          backend === "local"
            ? "https://github.com/openclaw/openclaw/pull/125200"
            : "https://github.com/owner/repository/pull/1",
      });
      expect(writes).toEqual(acceptedWrites);
      expect(f.publishedTitles).toEqual(["lost-pr-response"]);
    },
  );
});
