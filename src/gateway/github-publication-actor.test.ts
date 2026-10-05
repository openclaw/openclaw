import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as oauthClient from "../agents/github-oauth-client.js";
import * as nativeIdentity from "../agents/github-read-identity.js";
import * as githubIdentity from "../agents/github-tool-identity.js";
import * as configRuntime from "../config/config.js";
import * as profiles from "../state/user-profile-list.js";
import { redeemFactoryGitHubProof } from "./factory-github-proof.js";
import * as oauthLifecycle from "./github-oauth-lifecycle.js";
import {
  factoryPublicationPreflightCredential,
  prepareCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationOptionsIdentity,
} from "./github-publication-availability.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("binds each publication credential lookup to the current canonical session", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  vi.stubEnv("GH_TOKEN", "ambient-token");
  const release = vi.fn();
  vi.spyOn(profiles, "prepareUserProfileIdentity").mockResolvedValue({
    emailBindingIds: ["actor-binding"],
    readCurrentProfile: () => ({ profileId: "profile-a", assignedRole: null }),
    readCurrentFacts: () => ({
      profile: {
        profileId: "profile-a",
        assignedRole: null,
        emails: ["github:microsoft.ghe.com:101"],
      },
      aliases: new Set(["profile-a"]),
    }),
    release,
  });
  vi.spyOn(oauthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue();
  const observed: string[] = [];
  vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockImplementation(async (env) => {
    const proof = env.OPENCLAW_FACTORY_GITHUB_PROOF ?? "";
    observed.push(proof);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(redeemFactoryGitHubProof(proof)).toMatchObject({
      actorId: 101,
      purpose: "publication-preflight",
      binding: {
        kind: "session",
        sessionKey: "agent:main:own",
        sessionId: "session-1",
        lifecycleRevision: "revision-1",
      },
    });
    return "broker-token";
  });
  vi.spyOn(githubIdentity, "prepareGitHubPublicationIdentity").mockImplementation(
    async (params) => {
      const token = await params.readNativeCredential?.(params.env ?? {});
      if (!token) {
        throw new Error("proof lookup failed");
      }
      return {
        source: "system-detected",
        account: { accountId: 101, login: "engineer", avatarUrl: null },
        env: { ...params.env, GH_TOKEN: token },
      };
    },
  );
  const actor = { profileId: "profile-a", sessionKey: "agent:main:own", assertCurrent: vi.fn() };
  const credential = factoryPublicationPreflightCredential({
    agentId: "main",
    sessionKey: actor.sessionKey,
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    assertCurrent: () => {},
  });
  const prepared = await prepareCurrentGitHubPublicationIdentity("main", actor, credential);
  expect(prepared.env.OPENCLAW_FACTORY_GITHUB_PROOF).toBeUndefined();
  await prepareCurrentGitHubPublicationIdentity("main", actor, credential);
  expect(observed).toHaveLength(2);
  expect(observed[0]).not.toBe(observed[1]);
  expect(release).toHaveBeenCalledTimes(2);
});

it.each(["missing", "ambiguous", "revoked"] as const)(
  "refuses a publication lookup after actor binding is %s",
  async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    let revoked = false;
    const release = vi.fn();
    const facts = () => {
      if (revoked) {
        throw new Error("actor binding revoked");
      }
      return {
        profile: {
          profileId: "profile-a",
          assignedRole: null,
          emails:
            state === "missing"
              ? []
              : state === "ambiguous"
                ? ["github:microsoft.ghe.com:101", "github:microsoft.ghe.com:202"]
                : ["github:microsoft.ghe.com:101"],
        },
        aliases: new Set(["profile-a"]),
      };
    };
    vi.spyOn(profiles, "prepareUserProfileIdentity").mockResolvedValue({
      emailBindingIds: ["actor-binding"],
      readCurrentProfile: () => ({ profileId: "profile-a", assignedRole: null }),
      readCurrentFacts: facts,
      release,
    });
    vi.spyOn(oauthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue();
    const read = vi
      .spyOn(nativeIdentity, "readNativeGitHubToken")
      .mockImplementation(async (env) => {
        redeemFactoryGitHubProof(env.OPENCLAW_FACTORY_GITHUB_PROOF ?? "");
        revoked = true;
        return "broker-token";
      });
    vi.spyOn(githubIdentity, "prepareGitHubPublicationIdentity").mockImplementation(
      async (params) => {
        const token = await params.readNativeCredential?.(params.env ?? {});
        return {
          source: "system-detected",
          account: { accountId: 101, login: "engineer", avatarUrl: null },
          env: { GH_TOKEN: token },
        };
      },
    );
    const actor = { profileId: "profile-a", sessionKey: "agent:main:own" };
    const credential = factoryPublicationPreflightCredential({
      agentId: "main",
      sessionKey: actor.sessionKey,
      sessionId: "session-1",
      lifecycleRevision: null,
      assertCurrent: () => {},
    });
    await expect(
      prepareCurrentGitHubPublicationIdentity("main", actor, credential),
    ).rejects.toThrow(
      state === "revoked" ? "actor binding revoked" : "actor binding is unavailable or ambiguous",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(state === "revoked" ? 1 : 0);
  },
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["publication", "options"] as const)(
  "uses the selected bot for Factory %s while retaining human authority",
  async (usage) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("selected-bot-publication-"));
    const profileId = "ghp_11111111111111111111111111111111";
    let config = { tools: { github: { profileId } } };
    vi.spyOn(configRuntime, "getRuntimeConfig").mockImplementation(() => config);
    vi.spyOn(oauthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue();
    const directory = githubIdentity.resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
    });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, "hosts.yml"),
      "github.com:\n  oauth_token: synthetic-bot-token\n",
      { mode: 0o600 },
    );
    const native = vi
      .spyOn(nativeIdentity, "readNativeGitHubToken")
      .mockRejectedValue(new Error("must not borrow native credentials"));
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new Error("human authority revoked");
    };
    const actor = { profileId: "human-profile", sessionKey: "agent:main:own", assertCurrent };
    const credential = factoryPublicationPreflightCredential({
      agentId: "main",
      sessionKey: actor.sessionKey,
      sessionId: "same-session",
      lifecycleRevision: "same-life",
      assertCurrent,
    });
    const verify = vi
      .spyOn(oauthClient, "verifyGitHubCredential")
      .mockImplementation(async (token) => {
        expect(token).toBe("synthetic-bot-token");
        return {
          status: "available",
          scopes: [],
          account: { accountId: 202, login: "system-bot", avatarUrl: null },
        };
      });
    const prepare = () =>
      usage === "publication"
        ? prepareCurrentGitHubPublicationIdentity("main", actor, credential)
        : prepareCurrentGitHubPublicationOptionsIdentity("main", actor, credential);
    expect(await prepare()).toMatchObject({
      source: "system-configured",
      account: { accountId: 202, login: "system-bot" },
    });
    verify.mockImplementation(async () => {
      current = false;
      return {
        status: "available",
        scopes: [],
        account: { accountId: 202, login: "system-bot", avatarUrl: null },
      };
    });
    await expect(prepare()).rejects.toThrow("human authority revoked");
    current = true;
    verify.mockImplementation(async () => {
      config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
      return {
        status: "available",
        scopes: [],
        account: { accountId: 202, login: "system-bot", avatarUrl: null },
      };
    });
    await expect(prepare()).rejects.toThrow("GitHub publication identity changed");
    expect(native).not.toHaveBeenCalled();
  },
);
