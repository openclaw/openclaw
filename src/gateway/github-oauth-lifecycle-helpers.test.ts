import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearGitHubCredentialVerificationCache } from "../agents/github-oauth-client.js";
import * as githubOAuthRecords from "../agents/github-oauth-records.js";
import {
  inspectGitHubOAuthRecord,
  writeGitHubOAuthRecord,
} from "../agents/github-oauth-records.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { resolveRequestUrl } from "../plugin-sdk/request-url.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as userGitHubConnections from "../state/user-github-connections.js";
import { readUserGitHubConnectionAsync } from "../state/user-github-connections.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  configuredOAuthIdentities,
  captureGitHubOAuthAuthorizationIdentity,
} from "./github-oauth-lifecycle-helpers.js";
import { createGitHubOAuthLifecycle } from "./github-oauth-lifecycle.js";
import {
  ACCOUNT,
  configForScope,
  identity,
  oauthRecord,
  OLD_PROFILE,
  NEW_PROFILE,
  OTHER_PROFILE,
} from "./github-oauth-lifecycle.test-support.js";
import { createPersonalGitHubOAuthLifecycle } from "./github-personal-oauth.js";

describe("GitHub OAuth maintenance inventory", () => {
  it("bounds roster reads while preserving ordered identities and fresh configuration", () => {
    const count = 128;
    const entries: Record<string, { tools: { github?: GitHubToolIdentityConfig } }> = {};
    for (let index = count; index > 0; index -= 1) {
      entries[`agent-${String(index).padStart(3, "0")}`] = { tools: {} };
    }
    let reads = 0;
    const observed = new Proxy(entries, {
      get(target, key, receiver) {
        reads += typeof key === "string" && Object.hasOwn(target, key) ? 1 : 0;
        return Reflect.get(target, key, receiver);
      },
    });
    const config: OpenClawConfig = { agents: { entries: observed } };
    expect(configuredOAuthIdentities(config)).toEqual([]);
    // Idle maintenance should traverse a large roster a bounded number of times.
    expect(reads).toBeLessThanOrEqual(count * 4);

    const system = identity(OLD_PROFILE, { oauth: true, author: true });
    const agent = identity(NEW_PROFILE, { oauth: true, author: true });
    config.tools = { github: system };
    entries["agent-128"] = { tools: { github: agent } };
    entries["agent-064"] = { tools: { github: system } };
    entries["agent-001"] = { tools: { github: identity(OTHER_PROFILE) } };
    expect(configuredOAuthIdentities(config)).toEqual([
      { scope: "system", agentId: "system", identity: system },
      { scope: "agent", agentId: "agent-064", identity: system },
      { scope: "agent", agentId: "agent-128", identity: agent },
    ]);
    entries["agent-001"] = { tools: { github: agent } };
    delete entries["agent-128"];
    expect(configuredOAuthIdentities(config)).toEqual([
      { scope: "system", agentId: "system", identity: system },
      { scope: "agent", agentId: "agent-001", identity: agent },
      { scope: "agent", agentId: "agent-064", identity: system },
    ]);
  });
});

it("never captures a GitHub App signing key in OAuth device authorization state", () => {
  const config: OpenClawConfig = {
    tools: {
      github: {
        kind: "app-installation",
        profileId: OLD_PROFILE,
        app: {
          appId: 1,
          installationId: 2,
          accountId: 3,
          repositories: [{ id: 4, fullName: "example/project" }],
          permissions: { contents: "read" },
          privateKey: "synthetic-signing-key",
          keyVersion: "synthetic-v1",
        },
      },
    },
  };
  expect(() =>
    captureGitHubOAuthAuthorizationIdentity(config, { scope: "system", agentId: "main" }),
  ).toThrow("before connecting an OAuth identity");
  const oauth = identity(OLD_PROFILE, { oauth: true });
  config.tools = { github: oauth };
  const captured = captureGitHubOAuthAuthorizationIdentity(config, {
    scope: "system",
    agentId: "main",
  });
  expect(captured).toEqual(oauth);
  oauth.profileId = NEW_PROFILE;
  expect(captured?.profileId).toBe(OLD_PROFILE);
});

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
    const seed = async (refreshToken = common.refreshToken) => {
      if (owner) {
        updateUserGitHubConnection(
          owner,
          () => ({
            version: 1,
            generation: randomUUID(),
            selection: { kind: "connected", profileId: OLD_PROFILE, ...common, refreshToken },
          }),
          () => {},
        );
      } else {
        await writeGitHubOAuthRecord(
          oauthRecord(OLD_PROFILE, { ...common, refreshToken, createdAtMs: now - 60_000 }),
        );
      }
    };
    const dir = resolveManagedGitHubProfileDir({
      scope: kind === "shared" ? "system" : "personal",
      agentId: "main",
      profileId: OLD_PROFILE,
    });
    await seed();
    await writeManagedGitHubProfileFiles(dir, {
      login: ACCOUNT.login,
      token: "synthetic-old-access",
    });
    const config = configForScope("system", identity(OLD_PROFILE, { oauth: true }));
    const open = () => {
      const lifecycle = owner
        ? createPersonalGitHubOAuthLifecycle()
        : createGitHubOAuthLifecycle({
            getConfig: () => config,
            getPersistedConfig: async () => config,
            warn: () => {},
            scheduler: createTestGatewayScheduler(),
          });
      lifecycles.push(lifecycle);
      return {
        refresh: () =>
          "refreshEffectiveIdentity" in lifecycle
            ? lifecycle.refreshEffectiveIdentity("main")
            : lifecycle.refresh(owner!),
        stop: () => lifecycle.stop(),
      };
    };
    const read = async () => {
      if (owner) {
        return (await readUserGitHubConnectionAsync(owner))?.selection;
      }
      const row = await inspectGitHubOAuthRecord(OLD_PROFILE);
      return row.state === "valid" ? row.record : undefined;
    };
    return { open, read, seed, dir };
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
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (resolveRequestUrl(input) === "https://api.github.com/user") {
          return Response.json({ id: ACCOUNT.accountId, login: ACCOUNT.login });
        }
        expect(resolveRequestUrl(input)).toBe("https://github.com/login/oauth/access_token");
        posts++;
        return tokenResponse();
      }),
    );
    const lifecycle = f.open();
    await lifecycle.refresh();
    expect(posts).toBe(1);
    expect(await f.read()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
    await lifecycle.stop();
    await f.open().refresh();
    expect(posts).toBe(1);
  });

  it("restores a personal grant when preparing dispatch fails before HTTP", async () => {
    const f = await fixture("personal");
    vi.spyOn(userGitHubConnections, "prepareUserGitHubConnection").mockRejectedValueOnce(
      new Error("synthetic pre-dispatch preparation failure"),
    );
    const transport = vi.fn<typeof fetch>(async (input) =>
      resolveRequestUrl(input) === "https://api.github.com/user"
        ? Response.json({ id: ACCOUNT.accountId, login: ACCOUNT.login })
        : tokenResponse(),
    );
    vi.stubGlobal("fetch", transport);
    const lifecycle = f.open();
    await lifecycle.refresh();
    expect(transport).not.toHaveBeenCalled();
    const stored = await f.read();
    expect(stored).toMatchObject({ refreshToken: "synthetic-github-refresh-original" });
    expect(stored).not.toHaveProperty("refresh");
    expect(stored).toMatchObject({ refreshFailure: "failed" });
    await lifecycle.stop();
    await f.open().refresh();
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
        let exchanges = 0;
        let verifications = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (input, init) => {
            if (resolveRequestUrl(input) === "https://api.github.com/user") {
              verifications++;
              expect(new Headers(init?.headers).get("authorization")).toBe(
                "Bearer synthetic-rotated-access",
              );
              return Response.json({ id: ACCOUNT.accountId, login: ACCOUNT.login });
            }
            exchanges++;
            expect(resolveRequestUrl(input)).toBe("https://github.com/login/oauth/access_token");
            expect(init?.method).toBe("POST");
            expect(init?.redirect).toBe("error");
            expect(new Headers(init?.headers).get("content-type")).toBe(
              "application/x-www-form-urlencoded",
            );
            const form = new URLSearchParams(await new Response(init?.body).text());
            expect(form.get("grant_type")).toBe("refresh_token");
            expect(form.get("refresh_token")).toBe("synthetic-github-refresh-original");
            expect(form.get("client_id")).toBeTruthy();
            entered.resolve();
            await release.promise;
            return tokenResponse();
          }),
        );
        const lifecycle = f.open();
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
          expect(exchanges).toBe(1);
          expect(verifications).toBe(1);
          expect(await f.read()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
          expect(await fs.readFile(path.join(f.dir, "hosts.yml"), "utf8")).toContain(
            "synthetic-rotated-access",
          );
          await lifecycle.stop();
          await f.open().refresh();
          expect(exchanges).toBe(1);
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
          const first = f.open();
          await first.refresh();
          await first.refresh();
          await first.stop();
          await f.open().refresh();
          expect(exchanges).toBe(1);
          expect(await f.read()).toMatchObject({ refreshFailure: "failed" });
        },
      );
    },
  );
});
