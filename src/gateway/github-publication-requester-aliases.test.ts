// Register shared transport mocks before production publication owners load.
// oxfmt-ignore
import {
  createGitHubPublicationRequesterFixture,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import * as userProfileList from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import * as userProfiles from "../state/user-profiles.js";
import {
  getUserProfileListItem,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import {
  captureGitHubPublicationRequester,
  restoreGitHubPublicationRequester,
} from "./github-publication-requester.js";
import {
  createRequesterPolicyFixture,
  createRequesterPublicationFixture,
  guestScopes,
  holdWorkerTurn,
  prepareVisitorPublicationFixture,
} from "./github-publication-requester.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);

describe("shared GitHub publication requester alias bindings", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["alias interruption", "role revocation"] as const)(
    "uses current resumed-grant profile facts without profile SQL and checks callback %s",
    async (callbackChange) => {
      const f = await createRequesterPolicyFixture();
      const email = "publication-guest@example.test";
      const later = "publication-later-alias@example.test";
      const other = await ensureCanonicalUserProfileForEmail(
        "publication-alias-recipient@example.test",
      );
      await linkCanonicalUserProfileEmail("publication-secondary@example.test", f.guestProfile);
      const visitors = await prepareVisitorPublicationFixture(f);
      try {
        await visitors.start();
        await visitors.execute("visitor_invite", { email, days: 1 });
        const original = await createGitHubPublicationRequesterFixture({
          profileId: f.guestProfile,
          scopes: guestScopes,
          ...f.guestSource.session,
        });
        const restored = await restoreGitHubPublicationRequester(
          JSON.stringify(original.requester.snapshot),
          original.session,
          original.context.getCommittedRuntimeConfig,
        );
        onTestFinished(restored.release);
        original.release();
        const policy = getPluginRegistryState()?.activeRegistry?.gatewayAccessPolicies.find(
          (entry) => entry.pluginId === "visitor-access",
        )?.policy;
        if (!policy?.resume) {
          throw new Error("Visitor policy did not register grant resumption");
        }
        const resume = policy.resume;
        const observed = vi.spyOn(policy, "resume");
        const protocolProfile = vi.spyOn(userProfiles, "getUserProfileListItem");
        const native = vi.spyOn(f.database.db, "prepare");
        const assertWithoutProfileSql = () => {
          protocolProfile.mockClear();
          native.mockClear();
          restored.assertCurrent();
          expect(protocolProfile).not.toHaveBeenCalled();
          expect(
            native.mock.calls.filter(([sql]) =>
              /user_profiles|user_profile_emails|user_profile_identities/u.test(sql),
            ),
          ).toEqual([]);
        };
        invalidateOperatorRolePolicy(f.guestProfile);
        assertWithoutProfileSql();
        expect(observed.mock.lastCall?.[0].profile).toEqual({
          profileId: f.guestProfile,
          emails: [email, "publication-secondary@example.test"].toSorted(),
          assignedRole: null,
        });
        setDisplayName(f.guestProfile, "Current name");
        await linkCanonicalUserProfileEmail(later, f.guestProfile);
        await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
        invalidateOperatorRolePolicy(f.guestProfile);
        assertWithoutProfileSql();
        expect(observed.mock.lastCall?.[0].profile).toEqual({
          profileId: f.guestProfile,
          emails: [email, "publication-secondary@example.test", later].toSorted(),
          assignedRole: "maintainer",
        });
        await linkCanonicalUserProfileEmail(later, other.id);
        assertWithoutProfileSql();
        observed.mockImplementationOnce((context) => {
          const authority = resume(context);
          if (callbackChange === "alias interruption") {
            linkEmail(email, other.id);
            linkEmail(email, f.guestProfile);
          } else {
            setUserProfileRole(f.guestProfile, "revoked");
            invalidateOperatorRolePolicy(f.guestProfile);
          }
          return authority;
        });
        expect(restored.assertCurrent).toThrow(GitHubPublicationRequesterUnavailableError);
      } finally {
        await visitors.close();
      }
    },
  );

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      (["captured alias", "later alias"] as const).map((change) => ({ backend, change })),
    ),
  )(
    "binds queued $backend Visitor publication when $change changes",
    async ({ backend, change }) => {
      const f = await fixture(backend);
      const email = "publication-guest@example.test";
      await linkCanonicalUserProfileEmail(
        "publication-guest-secondary@example.test",
        f.guestProfile,
      );
      const other = await ensureCanonicalUserProfileForEmail(
        "publication-alias-recipient@example.test",
      );
      const visitors = await prepareVisitorPublicationFixture(f);
      try {
        await visitors.start();
        await visitors.execute("visitor_invite", { email, days: 1 });
        const grant = (await visitors.store.lookup(email))!;
        const original = await createGitHubPublicationRequesterFixture({
          profileId: f.guestProfile,
          scopes: guestScopes,
          ...f.guestSource.session,
        });
        const claim = await holdWorkerTurn(f);
        const input = f.request("interrupted-visitor-identity", original.requester);
        const queued = await f.coordinator.requestForSession(input);
        const staff =
          change === "captured alias"
            ? await f.coordinator.requestForSession(
                f.request("independent-maintainer", f.maintainer),
              )
            : undefined;
        expect(queued.status).toBe("requested");
        if (staff) {
          expect(staff.status).toBe("requested");
        }
        expect(f.externalWrites).toEqual([]);
        expect(original.requester.snapshot.grant?.aliasBindingIds).toHaveLength(2);
        expect(JSON.stringify(f.readRequester(queued.requestId))).not.toContain(email);
        if (change === "captured alias") {
          await linkCanonicalUserProfileEmail(email, other.id);
          expect(original.requester.assertCurrent).toThrow(
            GitHubPublicationRequesterUnavailableError,
          );
          await linkCanonicalUserProfileEmail(email, f.guestProfile);
          expect(original.requester.assertCurrent).toThrow(
            GitHubPublicationRequesterUnavailableError,
          );
        } else {
          setDisplayName(f.guestProfile, "Updated publication guest");
          const later = "publication-later-alias@example.test";
          await linkCanonicalUserProfileEmail(later, f.guestProfile);
          const retry = await createGitHubPublicationRequesterFixture({
            profileId: f.guestProfile,
            scopes: guestScopes,
            ...f.guestSource.session,
          });
          expect(retry.requester.snapshot.grant?.aliasBindingIds).toHaveLength(3);
          expect(
            (await f.coordinator.requestForSession({ ...input, requester: retry.requester }))
              .requestId,
          ).toBe(queued.requestId);
          expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
          retry.release();
          await linkCanonicalUserProfileEmail(later, other.id);
          expect(original.requester.assertCurrent).not.toThrow();
        }
        expect(getUserProfileListItem(f.guestProfile)).toMatchObject({
          id: f.guestProfile,
          emails: [email, "publication-guest-secondary@example.test"].toSorted(),
        });
        expect(await visitors.store.lookup(email)).toEqual(grant);
        expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
        await f.placements.releaseTurn(claim);
        original.release();
        await visitors.reopen();
        await visitors.start();
        const restarted = f.restart();
        await restarted.resumeSessionRequests();
        expect(restarted.read(queued.requestId)).toMatchObject(
          change === "captured alias"
            ? { status: "failed", code: "identity_changed" }
            : { status: "published" },
        );
        if (staff) {
          expect(restarted.read(staff.requestId)).toMatchObject({ status: "published" });
        }
        expect(f.publishedTitles.toSorted()).toEqual(
          change === "captured alias"
            ? ["independent-maintainer"]
            : ["interrupted-visitor-identity"],
        );
      } finally {
        await visitors.close();
      }
    },
  );

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      (["later alias removed", "request cancelled"] as const).map((change) => ({
        backend,
        change,
      })),
    ),
  )(
    "checks the accepted $backend policy during an immediate retry with $change",
    async ({ backend, change }) => {
      const f = await fixture(backend);
      const email = "publication-guest@example.test";
      const later = "publication-later-alias@example.test";
      const other = await ensureCanonicalUserProfileForEmail(
        "publication-alias-recipient@example.test",
      );
      const visitors = await prepareVisitorPublicationFixture(f);
      try {
        await visitors.start();
        await visitors.execute("visitor_invite", { email, days: 1 });
        const grant = (await visitors.store.lookup(email))!;
        const original = await createGitHubPublicationRequesterFixture({
          profileId: f.guestProfile,
          scopes: guestScopes,
          ...f.guestSource.session,
        });
        const claim =
          backend === "repository"
            ? await holdWorkerTurn(f)
            : await f.placements.claimTurn({
                ...f.session,
                agentId: "main",
                owner: { kind: "local" },
                claimId: "immediate-alias-retry-claim",
                runId: "immediate-alias-retry-run",
              });
        const input = f.request("immediate-alias-retry", original.requester);
        const queued = await f.coordinator.requestForClaim({ ...input, claim });
        expect(queued.status).toBe("requested");
        expect(f.externalWrites).toEqual([]);
        if (backend === "repository") {
          f.placements.markWorkspaceResultPending(claim);
          await f.coordinator.prepareClaimWorkspace(claim);
          f.placements.acceptWorkspaceResult(claim);
        }
        const accepted = f.readReceipt(queued.requestId)!;
        if (backend === "repository") {
          expect(accepted).toMatchObject({
            checkpoint_ref: expect.any(String),
            checkpoint_digest: expect.any(String),
          });
        }
        expect(original.requester.snapshot.grant?.aliasBindingIds).toHaveLength(1);

        await linkCanonicalUserProfileEmail(later, f.guestProfile);
        const controller = new AbortController();
        const retry = await captureGitHubPublicationRequester(
          {
            client: original.client,
            context: original.context,
            signal: controller.signal,
          },
          original.session,
        );
        onTestFinished(retry.release);
        expect(retry.requester.snapshot.grant?.aliasBindingIds).toHaveLength(2);
        if (backend === "repository") {
          f.placements.completeWorkspaceResultAndReleaseTurn(claim);
        } else {
          await f.placements.releaseTurn(claim);
        }
        const prepare = mocks.prepareIdentity.getMockImplementation()!;
        let preparations = 0;
        mocks.prepareIdentity.mockImplementation(async (...args) => {
          const identity = await prepare(...args);
          preparations += 1;
          // The first preparation admits the retry; the next belongs to its execution.
          if (preparations === 2) {
            if (change === "later alias removed") {
              await linkCanonicalUserProfileEmail(later, other.id);
            } else {
              controller.abort(new Error("publication retry cancelled"));
            }
            expect(original.requester.assertCurrent).not.toThrow();
          }
          return identity;
        });
        const result = await f.coordinator.requestForSession({
          ...input,
          requester: retry.requester,
        });
        expect(preparations).toBeGreaterThanOrEqual(2);
        expect(result).toMatchObject({
          requestId: queued.requestId,
          status: change === "later alias removed" ? "published" : "failed",
          ...(change === "request cancelled" ? { code: "identity_changed" } : {}),
        });
        expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
        expect(f.readReceipt(queued.requestId)?.request_digest).toBe(accepted.request_digest);
        expect(await visitors.store.lookup(email)).toEqual(grant);
        expect(f.publishedTitles).toEqual(change === "later alias removed" ? [input.title] : []);
        if (change === "request cancelled") {
          expect(f.externalWrites).toEqual([]);
        }
      } finally {
        await visitors.close();
      }
    },
  );

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      (["profile preparation is unavailable", "a profile mutation is unsettled"] as const).map(
        (availability) => ({ backend, availability }),
      ),
    ),
  )(
    "keeps an accepted $backend request pending when $availability",
    async ({ backend, availability }) => {
      const f = await fixture(backend);
      const visitors = await prepareVisitorPublicationFixture(f);
      try {
        await visitors.start();
        await visitors.execute("visitor_invite", {
          email: "publication-guest@example.test",
          days: 1,
        });
        const original = await createGitHubPublicationRequesterFixture({
          profileId: f.guestProfile,
          scopes: guestScopes,
          ...f.guestSource.session,
        });
        const claim = await holdWorkerTurn(f);
        const queued = await f.coordinator.requestForSession(
          f.request("profile-preparation-recovery", original.requester),
        );
        expect(queued.status).toBe("requested");
        if (backend === "repository") {
          f.placements.markWorkspaceResultPending(claim);
          await f.coordinator.prepareClaimWorkspace(claim);
          f.placements.acceptWorkspaceResult(claim);
        }
        const accepted = f.readReceipt(queued.requestId)!;
        if (backend === "repository") {
          expect(accepted).toMatchObject({
            checkpoint_ref: expect.any(String),
            checkpoint_digest: expect.any(String),
          });
          f.placements.completeWorkspaceResultAndReleaseTurn(claim);
        } else {
          await f.placements.releaseTurn(claim);
        }
        original.release();
        const restarted = f.restart();
        const preparation = vi.spyOn(userProfileList, "prepareUserProfileIdentity");
        const releasePublication = createDeferredCore();
        let mutation: Promise<unknown> | undefined;
        try {
          if (availability === "profile preparation is unavailable") {
            preparation.mockRejectedValueOnce(new Error("synthetic profile read unavailable"));
          } else {
            const prepare = mocks.prepareIdentity.getMockImplementation()!;
            mocks.prepareIdentity.mockImplementationOnce(async (...args) => {
              const identity = await prepare(...args);
              expect(preparation).toHaveBeenCalledOnce();
              const nativeSettlement = createDeferredCore<string>();
              const execute = stateWorker.runOpenClawStateWorkerOperation;
              const delivery = vi
                .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
                .mockImplementationOnce((context, operation, options) => {
                  const admit = options?.createAdmission;
                  if (!admit) {
                    throw new Error("Expected the canonical profile write admission");
                  }
                  return execute(context, operation, {
                    ...options,
                    createAdmission: ({ settled }) =>
                      admit({
                        settled: settled.then(async (result) => {
                          // Hold publication delivery after the real native transaction settles.
                          nativeSettlement.resolve(result.kind);
                          await releasePublication.promise;
                          return result;
                        }),
                      }),
                  });
                });
              try {
                mutation = linkCanonicalUserProfileEmail(
                  "publication-later-alias@example.test",
                  f.guestProfile,
                );
                await expect(
                  Promise.race([nativeSettlement.promise, mutation.then(() => "delivered")]),
                ).resolves.toBe("completed");
              } finally {
                delivery.mockRestore();
              }
              return identity;
            });
          }
          await expect(restarted.resumeSessionRequests()).rejects.toBeInstanceOf(AggregateError);
          expect(preparation).toHaveBeenCalledOnce();
          if (availability === "a profile mutation is unsettled") {
            expect(mutation).toBeDefined();
          }
          expect(restarted.read(queued.requestId)).toMatchObject({
            status: backend === "local" ? "publishing" : "requested",
          });
          expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
          expect(f.readReceipt(queued.requestId)?.request_digest).toBe(accepted.request_digest);
          expect(f.readReceipt(queued.requestId)?.error_code).toBeNull();
          expect(f.externalWrites).toEqual([]);
        } finally {
          preparation.mockRestore();
          releasePublication.resolve();
          await mutation;
        }
        await restarted.resumeSessionRequests();
        expect(restarted.read(queued.requestId)).toMatchObject({ status: "published" });
        expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
        expect(f.readReceipt(queued.requestId)?.request_digest).toBe(accepted.request_digest);
        expect(f.publishedTitles).toEqual(["profile-preparation-recovery"]);
      } finally {
        await visitors.close();
      }
    },
  );

  it("retains the winning repository request's bindings across concurrent alias-addition retries", async () => {
    const f = await fixture("repository");
    const visitors = await prepareVisitorPublicationFixture(f);
    try {
      await visitors.start();
      await visitors.execute("visitor_invite", {
        email: "publication-guest@example.test",
        days: 1,
      });
      const original = await createGitHubPublicationRequesterFixture({
        profileId: f.guestProfile,
        scopes: guestScopes,
        ...f.guestSource.session,
      });
      const claim = await holdWorkerTurn(f);
      const input = f.request("concurrent-alias-retry", original.requester);
      const later = "publication-later-alias@example.test";
      let winner: Awaited<ReturnType<typeof f.coordinator.requestForSession>> | undefined;
      let winningSnapshot: typeof original.requester.snapshot | undefined;
      const prepare = mocks.prepareIdentity.getMockImplementation()!;
      mocks.prepareIdentity.mockImplementationOnce(async (...args) => {
        const identity = await prepare(...args);
        await linkCanonicalUserProfileEmail(later, f.guestProfile);
        const retry = await createGitHubPublicationRequesterFixture({
          profileId: f.guestProfile,
          scopes: guestScopes,
          ...f.guestSource.session,
        });
        winningSnapshot = retry.requester.snapshot;
        winner = await f.coordinator.requestForSession({ ...input, requester: retry.requester });
        return identity;
      });
      const admitted = await f.coordinator.requestForSession(input);
      expect(admitted.requestId).toBe(winner?.requestId);
      expect(admitted.status).toBe("requested");
      expect(original.requester.snapshot.grant?.aliasBindingIds).toHaveLength(1);
      expect(winningSnapshot?.grant?.aliasBindingIds).toHaveLength(2);
      expect(f.readRequester(admitted.requestId)).toEqual(winningSnapshot);
      const other = await ensureCanonicalUserProfileForEmail(
        "publication-alias-recipient@example.test",
      );
      await linkCanonicalUserProfileEmail(later, other.id);
      expect(original.requester.assertCurrent).not.toThrow();
      await f.placements.releaseTurn(claim);
      original.release();
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(restarted.read(admitted.requestId)).toMatchObject({
        status: "failed",
        code: "identity_changed",
      });
      expect(f.readRequester(admitted.requestId)).toEqual(winningSnapshot);
      expect(f.externalWrites).toEqual([]);
    } finally {
      await visitors.close();
    }
  });
});
