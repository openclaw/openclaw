import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSyntheticGitHubEnrollmentIssuer,
  syntheticAccessToken,
  syntheticRefreshToken,
  withGitHubEnrollmentEffectFixture,
  type SyntheticEnrollmentIssuer,
} from "./github-enrollment-effects.test-support.js";

// Real lifecycle, transport/parser, profile files and SQLite; no external GitHub authorization.
// The timeout factory runs inside OAuth transport preparation, before its final dispatch guard.
// This deterministically revokes authority after the lifecycle's earlier guard, not inside fetch.
function revokeBeforeOAuthDispatch(revoke: () => void) {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, "timeout").mockImplementationOnce((ms) => {
    revoke();
    return realTimeout(ms);
  });
}

describe("GitHub enrollment final effects with a synthetic loopback issuer", () => {
  let issuer: SyntheticEnrollmentIssuer;
  beforeAll(async () => {
    issuer = await createSyntheticGitHubEnrollmentIssuer();
  });
  afterAll(async () => {
    await issuer?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("installs and durably selects the allowed human's parsed OAuth grant", async () => {
    await withGitHubEnrollmentEffectFixture(issuer, async (f) => {
      const started = await f.lifecycle.startAuthorization(f.action);
      expect(started.userCode).toBe("ABCD-1234");
      expect(started.verificationUri).toBe("https://github.com/login/device");
      f.advancePoll();
      await expect(
        f.lifecycle.pollAuthorization(f.action, started.requestId),
      ).resolves.toMatchObject({
        status: "success",
        personal: {
          state: "connected",
          account: { accountId: 4242, login: "synthetic-enrollee" },
          pending: null,
        },
      });
      const stored = await f.readConnection();
      expect(stored?.pending).toBeUndefined();
      expect(stored?.selection).toMatchObject({
        kind: "connected",
        accountId: 4242,
        login: "synthetic-enrollee",
        refreshToken: syntheticRefreshToken,
        scopes: ["gist", "read:org", "repo", "workflow"],
      });
      if (stored?.selection.kind !== "connected") {
        throw new Error("Expected durable connected selection");
      }
      expect(await f.readHosts(stored.selection.profileId)).toContain(syntheticAccessToken);
      expect(await f.installedHosts()).toHaveLength(1);
      expect(issuer.requests.map(({ path, method }) => [path, method])).toEqual([
        [issuer.devicePath, "POST"],
        [issuer.tokenPath, "POST"],
        [issuer.accountPath, "GET"],
      ]);
      expect(new URLSearchParams(issuer.requests[0]!.body).get("scope")).toBe(
        "repo workflow read:org gist offline_access",
      );
      expect(new URLSearchParams(issuer.requests[1]!.body).get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      expect(issuer.requests[2]!.authorization).toBe(`Bearer ${syntheticAccessToken}`);
    });
  });

  it.each(["restricted", "pending-profile"] as const)(
    "rejects an already %s human before enrollment HTTP",
    async (state) => {
      await withGitHubEnrollmentEffectFixture(issuer, async (f) => {
        if (state === "restricted") {
          f.restrict();
        } else {
          f.pendingProfile();
        }
        await expect(f.lifecycle.startAuthorization(f.action)).rejects.toThrow();
        expect(issuer.requests).toHaveLength(0);
        expect(await f.readConnection()).toBeUndefined();
        expect(await f.installedHosts()).toEqual([]);
      });
    },
  );

  it.each([
    { phase: "start", state: "restricted" },
    { phase: "poll", state: "restricted" },
    { phase: "start", state: "pending-profile" },
    { phase: "poll", state: "pending-profile" },
  ] as const)(
    "does not dispatch $phase after $state withdrawal in transport preparation",
    async ({ phase, state }) => {
      await withGitHubEnrollmentEffectFixture(issuer, async (f) => {
        const started =
          phase === "poll" ? await f.lifecycle.startAuthorization(f.action) : undefined;
        f.advancePoll();
        const before = issuer.requests.length;
        const hook = revokeBeforeOAuthDispatch(
          state === "restricted" ? f.restrict : f.pendingProfile,
        );
        await expect(
          started
            ? f.lifecycle.pollAuthorization(f.action, started.requestId)
            : f.lifecycle.startAuthorization(f.action),
        ).rejects.toThrow();
        expect(hook).toHaveBeenCalled();
        // Expected pre-fix failure: one physical loopback POST, not setup or mocked parsing.
        expect(issuer.requests).toHaveLength(before);
        expect((await f.readConnection())?.selection.kind).not.toBe("connected");
        expect(await f.installedHosts()).toEqual([]);
      });
    },
  );

  it("does not install or select tokens returned after pending authorization cancellation", async () => {
    await withGitHubEnrollmentEffectFixture(issuer, async (f) => {
      const started = await f.lifecycle.startAuthorization(f.action);
      f.advancePoll();
      let cancelled = false;
      issuer.beforeReply(async (pathname) => {
        if (pathname === issuer.tokenPath) {
          cancelled = await f.lifecycle.cancelAuthorizationAsync(f.action, started.requestId);
        }
      });
      await expect(
        f.lifecycle.pollAuthorization(f.action, started.requestId),
      ).resolves.toMatchObject({ status: "failed", reason: "identity_changed" });
      expect(cancelled).toBe(true);
      expect((await f.readConnection())?.pending).toBeUndefined();
      expect((await f.readConnection())?.selection.kind).not.toBe("connected");
      expect(await f.installedHosts()).toEqual([]);
      expect(issuer.requests.map(({ path }) => path)).toEqual([
        issuer.devicePath,
        issuer.tokenPath,
      ]);
    });
  });

  it.each(["restricted", "pending-profile"] as const)(
    "does not publish a credential profile or select it after %s downgrade during account verification",
    async (state) => {
      await withGitHubEnrollmentEffectFixture(issuer, async (f) => {
        const started = await f.lifecycle.startAuthorization(f.action);
        f.advancePoll();
        let downgraded = false;
        issuer.beforeReply(async (pathname) => {
          if (pathname === issuer.accountPath) {
            downgraded = true;
            if (state === "restricted") {
              f.restrict();
            } else {
              f.pendingProfile();
            }
          }
        });
        await expect(f.lifecycle.pollAuthorization(f.action, started.requestId)).rejects.toThrow();
        expect(downgraded).toBe(true);
        expect((await f.readConnection())?.selection.kind).not.toBe("connected");
        expect(await f.installedHosts()).toEqual([]);
        expect(issuer.requests.map(({ path }) => path)).toEqual([
          issuer.devicePath,
          issuer.tokenPath,
          issuer.accountPath,
        ]);
      });
    },
  );
});
