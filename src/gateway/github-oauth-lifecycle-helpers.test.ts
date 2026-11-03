import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as githubOAuthRecords from "../agents/github-oauth-records.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequestUrl } from "../plugin-sdk/request-url.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as userGitHubConnections from "../state/user-github-connections.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  ACCOUNT,
  clearGitHubCredentialVerificationCache,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
  startRegisteredGitHubOAuth,
  configForScope,
  identity,
  oauthRecord,
  OLD_PROFILE,
} from "./github-oauth-lifecycle.test-support.js";

describe("GitHub OAuth real refresh boundary", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const lifecycles: Array<{ stop(): Promise<void> }> = [];
  beforeEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("github-refresh-boundary-"));
    clearGitHubCredentialVerificationCache();
  });
  afterEach(async () => {
    await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.stop()));
    clearGitHubCredentialVerificationCache();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function fixture(kind: "shared" | "personal") {
    const now = Date.now();
    const common = {
      accountId: ACCOUNT.accountId,
      login: ACCOUNT.login,
      refreshToken: "synthetic-github-refresh-original",
      accessExpiresAtMs: now + 1_000,
      refreshExpiresAtMs: now + 86_400_000,
      scopes: ["repo", "workflow"],
    };
    const owner =
      kind === "personal"
        ? (await ensureCanonicalUserProfileForEmail("refresh@example.test")).id
        : undefined;
    if (owner) {
      updateUserGitHubConnection(
        owner,
        () => ({
          version: 1,
          generation: randomUUID(),
          selection: { kind: "connected", profileId: OLD_PROFILE, ...common },
        }),
        () => {},
      );
    } else {
      await githubOAuthRecords.writeGitHubOAuthRecord(
        oauthRecord(OLD_PROFILE, { ...common, createdAtMs: now - 60_000 }),
      );
    }
    const dir = resolveManagedGitHubProfileDir({
      scope: kind === "shared" ? "system" : "personal",
      agentId: "main",
      profileId: OLD_PROFILE,
    });
    await writeManagedGitHubProfileFiles(dir, {
      login: ACCOUNT.login,
      token: "synthetic-old-access",
    });
    const config = configForScope("system", identity(OLD_PROFILE, { oauth: true }));
    const open = async () => {
      const fixture = await startRegisteredGitHubOAuth(() => config);
      lifecycles.push(fixture);
      return {
        refresh: () =>
          owner
            ? fixture.oauth.personal.refresh(owner)
            : fixture.oauth.refreshEffectiveIdentity("main"),
        stop: fixture.stop,
      };
    };
    const read = async () => {
      if (owner) {
        return (await userGitHubConnections.readUserGitHubConnectionAsync(owner))?.selection;
      }
      const row = await githubOAuthRecords.inspectGitHubOAuthRecord(OLD_PROFILE);
      return row.state === "valid" ? row.record : undefined;
    };
    return { open, read, dir };
  }

  function tokenResponse() {
    return Response.json({
      access_token: "synthetic-rotated-access",
      refresh_token: "synthetic-rotated-refresh",
      token_type: "bearer",
      scope: "repo workflow read:org gist",
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    });
  }

  function stubTransport(exchange: typeof fetch = async () => tokenResponse()) {
    const post = vi.fn(exchange);
    const verify = vi.fn<typeof fetch>(async () =>
      Response.json({ id: ACCOUNT.accountId, login: ACCOUNT.login }),
    );
    const transport = vi.fn<typeof fetch>((input, init) => {
      if (resolveRequestUrl(input) === "https://api.github.com/user") {
        return verify(input, init);
      }
      expect(resolveRequestUrl(input)).toBe("https://github.com/login/oauth/access_token");
      return post(input, init);
    });
    vi.stubGlobal("fetch", transport);
    return { post, verify, transport };
  }

  it("reconciles a committed shared refresh claim whose write reply is lost", async () => {
    const f = await fixture("shared");
    const originalWrite = githubOAuthRecords.writeGitHubOAuthRecord;
    let loseReply = true;
    vi.spyOn(githubOAuthRecords, "writeGitHubOAuthRecord").mockImplementation(
      async (record, expected) => {
        await originalWrite(record, expected);
        if (record.refreshClaim && loseReply) {
          loseReply = false;
          throw new Error("synthetic lost claim commit reply");
        }
      },
    );
    const { post } = stubTransport();
    const lifecycle = await f.open();
    await lifecycle.refresh();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await f.read()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
    await lifecycle.stop();
    await (await f.open()).refresh();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("restores a personal grant when preparing dispatch fails before HTTP", async () => {
    const f = await fixture("personal");
    vi.spyOn(userGitHubConnections, "prepareUserGitHubConnection").mockRejectedValueOnce(
      new Error("synthetic pre-dispatch preparation failure"),
    );
    const { transport } = stubTransport();
    const lifecycle = await f.open();
    await lifecycle.refresh();
    expect(transport).not.toHaveBeenCalled();
    const stored = await f.read();
    expect(stored).toMatchObject({
      refreshToken: "synthetic-github-refresh-original",
      refreshFailure: "failed",
    });
    expect(stored).not.toHaveProperty("refresh");
    await lifecycle.stop();
    await (await f.open()).refresh();
    expect(await f.read()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  describe.each(["shared", "personal"] as const)(
    "GitHub %s real HTTP and durable owner",
    (kind) => {
      it("coalesces admitted callers, commits rotation and materializes the verified account", async () => {
        const f = await fixture(kind);
        const entered = deferred();
        const release = deferred();
        const { post, verify } = stubTransport(async (_input, init) => {
          expect(init).toMatchObject({ method: "POST", redirect: "error" });
          expect(new Headers(init?.headers).get("content-type")).toBe(
            "application/x-www-form-urlencoded",
          );
          const form = new URLSearchParams(await new Response(init?.body).text());
          expect(Object.fromEntries(form)).toMatchObject({
            grant_type: "refresh_token",
            refresh_token: "synthetic-github-refresh-original",
          });
          expect(form.get("client_id")).toBeTruthy();
          entered.resolve();
          await release.promise;
          return tokenResponse();
        });
        const lifecycle = await f.open();
        const first = lifecycle.refresh();
        const second = lifecycle.refresh();
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            first,
            "refresh settled before token POST",
          );
          release.resolve();
          await Promise.all([first, second]);
          expect(post).toHaveBeenCalledTimes(1);
          expect(verify).toHaveBeenCalledTimes(1);
          expect(new Headers(verify.mock.calls[0]![1]?.headers).get("authorization")).toBe(
            "Bearer synthetic-rotated-access",
          );
          expect(await f.read()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
          expect(await fs.readFile(path.join(f.dir, "hosts.yml"), "utf8")).toContain(
            "synthetic-rotated-access",
          );
          await lifecycle.stop();
          await (await f.open()).refresh();
          expect(post).toHaveBeenCalledTimes(1);
        } finally {
          release.resolve();
          await Promise.allSettled([first, second]);
        }
      });

      it.each(["lost-response", "server-error", "nested-rejection", "invalid-success"] as const)(
        "does not replay an uncertain or rejected grant after %s, including owner restart",
        async (failure) => {
          const f = await fixture(kind);
          let exchanges = 0;
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input) => {
              expect(resolveRequestUrl(input)).toBe("https://github.com/login/oauth/access_token");
              exchanges++;
              if (failure === "lost-response") {
                throw new TypeError("synthetic connection lost after consumption");
              }
              if (failure === "server-error") {
                return Response.json({ message: "temporarily unavailable" }, { status: 503 });
              }
              if (failure === "nested-rejection") {
                return Response.json({ error: { code: "invalid_grant" } });
              }
              return Response.json({
                access_token: "synthetic-new-access",
                refresh_token: 7,
                token_type: "bearer",
              });
            }),
          );
          const first = await f.open();
          await first.refresh();
          await first.refresh();
          await first.stop();
          await (await f.open()).refresh();
          expect(exchanges).toBe(1);
          expect(await f.read()).toMatchObject({ refreshFailure: "failed" });
        },
      );
    },
  );
});
