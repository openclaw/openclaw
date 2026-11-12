// Install transport fixtures before publication owners enter the module cache.
// oxfmt-ignore
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  decodeGitHubPublicationRequester,
  encodeGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import {
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  mergeCanonicalUserProfiles,
} from "../state/user-profile-writes.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { restoreGitHubPublicationRequester } from "./github-publication-requester.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPublicationFixture,
  holdWorkerTurn,
  forPublicationBackends,
} from "./github-publication-requester.test-support.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";

const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Repository checkpoints are external worker I/O; requester policy and storage are real.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const principal: OpenClawIdTunnelPrincipal = {
  kind: "member",
  peerKey: `iroh:${"ab".repeat(32)}`,
  accountId: "publication-member",
  role: "maintainer",
  authority: { clawId: "publication-claw", rootPub: "publication-root", listedSeq: 1 },
};

afterEach(() => setOpenClawIdTunnelPrincipalLookup(undefined));

it("refuses unattested membership and member-attributed System publication snapshots", () => {
  const snapshot = {
    version: 1,
    actor: { kind: "operator", profileId: "profile" },
    scopes: ["operator.admin"],
    grant: null,
    openclawIdPrincipal: principal,
    authenticationSource: "openclaw-id-member",
  };
  expect(decodeGitHubPublicationRequester(JSON.stringify(snapshot))).toMatchObject({
    openclawIdPrincipal: principal,
  });
  expect(
    decodeGitHubPublicationRequester(
      JSON.stringify({ ...snapshot, openclawIdPrincipal: { ...principal, authority: undefined } }),
    ),
  ).toBeUndefined();
  for (const invalid of [
    { ...snapshot, openclawIdPrincipal: undefined },
    { ...snapshot, authenticationSource: "non-member" },
  ]) {
    expect(decodeGitHubPublicationRequester(JSON.stringify(invalid))).toBeUndefined();
  }
  expect(
    decodeGitHubPublicationRequester(JSON.stringify({ ...snapshot, actor: { kind: "system" } })),
  ).toBeUndefined();
});

describe("member publication authority", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["allowed", "removed", "downgraded", "policy required"] as const)(
    "uses the connection's membership on queued publication (%s)",
    async (change) => {
      const f = await createRequesterPublicationFixture(checkpoint, "repository");
      setOpenClawIdTunnelPrincipalLookup(() => principal);
      const captured = await createGitHubPublicationRequesterFixture({
        profileId: f.guestProfile,
        scopes: ["operator.admin"],
        ...f.guestSource.session,
        openclawIdPrincipal: principal,
      });
      expect(captured.requester.snapshot.actor).toEqual({
        kind: "operator",
        profileId: f.guestProfile,
      });
      expect(captured.requester.snapshot).toMatchObject({
        authenticationSource: "openclaw-id-member",
        openclawIdPrincipal: principal,
      });
      expect(Object.isFrozen(captured.requester.snapshot.openclawIdPrincipal)).toBe(true);
      expect(Object.isFrozen(captured.requester.snapshot.openclawIdPrincipal?.authority)).toBe(
        true,
      );
      const json = encodeGitHubPublicationRequester(captured.requester.snapshot);
      expect(decodeGitHubPublicationRequester(json)).toEqual(captured.requester.snapshot);
      const restored = await restoreGitHubPublicationRequester(
        json,
        f.guestSource.session,
        f.guestSource.context.getCommittedRuntimeConfig,
      );
      onTestFinished(restored.release);
      const claim = await holdWorkerTurn(f);
      const accepted = await f.coordinator.requestForSessionV2(
        f.request("member-publication", captured.requester),
      );
      expect(accepted.status).toBe("requested");
      expect(f.readRequester(accepted.requestId)).toEqual(captured.requester.snapshot);
      captured.release();
      expect(restored.assertCurrent).not.toThrow();
      if (change === "removed") {
        setOpenClawIdTunnelPrincipalLookup(() => undefined);
      } else if (change !== "allowed") {
        const next = structuredClone(f.config);
        const role = next.gateway!.roles!.definitions.maintainer!;
        if (change === "downgraded") {
          role.scopes = ["operator.read"];
        } else {
          role.accessPolicyPlugin = "member-policy";
        }
        setRuntimeConfigSnapshot(next);
      }
      if (change !== "allowed") {
        expect(restored.assertCurrent).toThrow(GitHubPublicationRequesterUnavailableError);
        await expect(
          restoreGitHubPublicationRequester(
            json,
            f.guestSource.session,
            f.guestSource.context.getCommittedRuntimeConfig,
          ),
        ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
      }
      await f.placements.releaseTurn(claim);
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(accepted.requestId)).toMatchObject(
        change === "allowed"
          ? { status: "published" }
          : { status: "failed", code: "identity_changed" },
      );
      expect(f.publishedTitles).toEqual(change === "allowed" ? ["member-publication"] : []);
      if (change !== "allowed") {
        expect(f.externalWrites).toEqual([]);
      }
    },
  );
  it.each(forPublicationBackends(["member", "nonmember"] as const))(
    "rechecks parent-format $change provenance at recovery and write ($backend)",
    async ({ backend, change }) => {
      const f = await createRequesterPublicationFixture(checkpoint, backend);
      const config = structuredClone(f.config);
      delete config.gateway!.roles!.default;
      setRuntimeConfigSnapshot(config);
      const captured = await createGitHubPublicationRequesterFixture({
        profileId: f.guestProfile,
        scopes: ["operator.admin"],
        ...f.guestSource.session,
      });
      const currentJson = encodeGitHubPublicationRequester(captured.requester.snapshot);
      expect(decodeGitHubPublicationRequester(currentJson)).toEqual(captured.requester.snapshot);
      expect(captured.requester.snapshot.authenticationSource).toBe("non-member");
      const json = JSON.stringify({
        version: 1,
        actor: { kind: "operator", profileId: f.guestProfile },
        scopes: ["operator.admin"],
        grant: null,
      });
      const restored = await restoreGitHubPublicationRequester(
        json,
        f.guestSource.session,
        f.guestSource.context.getCommittedRuntimeConfig,
      );
      onTestFinished(restored.release);
      const claim = await holdWorkerTurn(f);
      const accepted = await f.coordinator.requestForSessionV2(
        f.request("historical-publication", captured.requester),
      );
      expect(accepted.status).toBe("requested");
      f.replaceRequesterSnapshot(accepted.requestId, json);
      if (change === "member") {
        const member = await ensureCanonicalUserProfileForOpenClawIdIdentity({
          accountId: principal.accountId,
        });
        await mergeCanonicalUserProfiles(member.id, f.guestProfile);
        // The canonical identity remains OCID-bound even with remote access off.
        setOpenClawIdTunnelPrincipalLookup(undefined);
        const knownNonmember = await restoreGitHubPublicationRequester(
          currentJson,
          f.guestSource.session,
          f.guestSource.context.getCommittedRuntimeConfig,
        );
        onTestFinished(knownNonmember.release);
        expect(knownNonmember.assertCurrent).not.toThrow();
        expect(restored.assertCurrent).toThrow(GitHubPublicationRequesterUnavailableError);
        await expect(
          restoreGitHubPublicationRequester(
            json,
            f.guestSource.session,
            f.guestSource.context.getCommittedRuntimeConfig,
          ),
        ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
      } else {
        expect(restored.assertCurrent).not.toThrow();
        expect(
          await f.coordinator.requestForSessionV2(
            f.request("historical-publication", captured.requester),
          ),
        ).toMatchObject({ requestId: accepted.requestId });
        expect(f.readRequester(accepted.requestId)).toEqual(JSON.parse(json));
      }
      await f.placements.releaseTurn(claim);
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(accepted.requestId)).toMatchObject(
        change === "member"
          ? { status: "failed", code: "identity_changed" }
          : { status: "published" },
      );
      expect(f.publishedTitles).toEqual(change === "member" ? [] : ["historical-publication"]);
      if (change === "member") {
        expect(f.externalWrites).toEqual([]);
      }
    },
  );
  it("does not widen a nonadministrator member's existing publication cap", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "repository");
    const writer = { ...principal, role: "writer" };
    const next = structuredClone(f.config);
    next.gateway!.roles!.definitions.writer = {
      scopes: ["operator.write"],
      agents: "*",
      sessions: { others: "write" },
    };
    setRuntimeConfigSnapshot(next);
    setOpenClawIdTunnelPrincipalLookup(() => writer);
    await expect(
      createGitHubPublicationRequesterFixture({
        profileId: f.guestProfile,
        scopes: ["operator.write"],
        ...f.guestSource.session,
        openclawIdPrincipal: writer,
      }),
    ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
  });
  it("waits for membership hydration rather than permanently revoking a valid requester", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "repository");
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    const captured = await createGitHubPublicationRequesterFixture({
      profileId: f.guestProfile,
      scopes: ["operator.admin"],
      ...f.guestSource.session,
      openclawIdPrincipal: principal,
    });
    const json = encodeGitHubPublicationRequester(captured.requester.snapshot);
    let ready = false;
    let unavailable = true;
    setOpenClawIdTunnelPrincipalLookup(
      () => (ready ? principal : undefined),
      async () => {
        if (unavailable) {
          throw new Error("membership storage unavailable");
        }
        ready = true;
      },
    );
    await expect(
      restoreGitHubPublicationRequester(
        json,
        f.guestSource.session,
        f.guestSource.context.getCommittedRuntimeConfig,
      ),
    ).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
    unavailable = false;
    const restored = await restoreGitHubPublicationRequester(
      json,
      f.guestSource.session,
      f.guestSource.context.getCommittedRuntimeConfig,
    );
    onTestFinished(restored.release);
    expect(restored.assertCurrent).not.toThrow();
  });
});
