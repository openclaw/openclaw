// Keep external GitHub I/O synthetic while exercising registered admission and current profile state.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness, overrideCommands, SESSION_ID, SESSION_KEY } from "./github-publication.test-support.js";
// Install the existing tool transport before loading the publication tool.
// oxfmt-ignore
import { withPublicationToolTransport } from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { SessionGitHubPullRequestInspectResultSchema } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { setCanonicalUserPreferences } from "../state/user-preferences.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import {
  syncCanonicalGitHubIdentity,
  ensureCanonicalEnterpriseGitHubProfile,
  linkCanonicalUserProfileEmail,
} from "../state/user-profile-writes.js";
import { createRequesterPolicyFixture } from "./github-publication-requester.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const mocks = githubPublicationTestMocks();
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const session = () => loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY });
const verifyEnterprise = (host: string, id = 101, login = "contributor", name = "Contributor") =>
  ensureCanonicalEnterpriseGitHubProfile(`github:${host}:${id}`, name, {}, { login });

async function fixture(
  options: { linked?: boolean; host?: string; repository?: string; login?: string } = {},
) {
  const f = await createRequesterPolicyFixture({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  const host = options.host ?? "github.com";
  const config = { ...f.config, gateway: { ...f.config.gateway, github: { host } } };
  setRuntimeConfigSnapshot(config);
  if (options.linked !== false) {
    if (host === "github.com") {
      await syncCanonicalGitHubIdentity({
        identity: { accountId: 101, login: "contributor" },
        authenticationAlias: { kind: "email", email: "publication-guest@example.test" },
      });
    } else {
      // The Enterprise identity write binds its proof to the profile that currently holds the alias.
      await linkCanonicalUserProfileEmail(`github:${host}:101`, f.guestProfile);
      await verifyEnterprise(host);
    }
  }
  mocks.prepareIdentity.mockResolvedValue({
    source: "system-detected",
    host,
    env: {},
    account: { accountId: 42, login: "publisher" },
  });
  const baseRepo = {
    id: 10,
    full_name: options.repository ?? "example/repository",
    private: false,
  };
  const fork = {
    id: 20,
    full_name: "contributor/repository",
    private: false,
  };
  const pr = {
    number: 7,
    html_url: `https://${host}/${baseRepo.full_name}/pull/7`,
    user: { id: 101, login: options.login ?? "contributor" },
    state: "open",
    draft: false,
    merged: false,
    base: { repo: baseRepo, ref: "release", sha: BASE },
    head: { repo: fork as typeof fork | typeof baseRepo | null, ref: "topic/existing", sha: HEAD },
  };
  let accessId = 101;
  let access = "read";
  let beforeRead: ((endpoint: string) => Promise<void>) | undefined;
  const requests: string[][] = [];
  mocks.runCommand.mockImplementation(async (argv: string[]) => {
    requests.push(argv);
    if (argv[0] !== "gh" || !argv.includes("GET")) {
      throw new Error("Inspection attempted a non-read command");
    }
    const endpoint = argv.at(-1)!;
    await beforeRead?.(endpoint);
    const value =
      endpoint === `repos/${baseRepo.full_name}`
        ? baseRepo
        : endpoint === "repos/contributor/repository"
          ? fork
          : endpoint === `repos/${baseRepo.full_name}/pulls/7`
            ? pr
            : endpoint.startsWith("user/")
              ? { id: Number(endpoint.slice(5)), login: pr.user.login }
              : endpoint.endsWith(`/collaborators/${pr.user.login}/permission`)
                ? { permission: access, user: { id: accessId } }
                : undefined;
    return value ? commandResult(JSON.stringify(value)) : commandResult("", 1);
  });
  const invoke = async (args: Record<string, unknown> = {}, raw = false) => {
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: randomUUID(), method, params },
        client: f.guestSource.client,
        context: f.guestSource.context as GatewayRequestContext,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    const input = { action: "inspect_pr", pullRequestUrl: pr.html_url, ...args };
    return await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: SESSION_KEY },
      async () =>
        raw
          ? await callGateway("sessions.github.action", { sessionKey: SESSION_KEY, ...input })
          : (
              await withPublicationToolTransport(callGateway, () =>
                createGitHubPublishTool().execute("inspect", input),
              )
            ).details,
    );
  };
  return {
    ...f,
    pr,
    baseRepo,
    fork,
    requests,
    endpoints: () => requests.map((args) => args.at(-1)!),
    invoke,
    onRead(callback: (endpoint: string) => Promise<void>) {
      beforeRead = callback;
    },
    setAccess(permission: string, id = 101) {
      access = permission;
      accessId = id;
    },
  };
}

describe("own PR inspection through the admitted agent tool and Gateway", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
  });

  it.each([
    ["same repository", "github.com"],
    ["fork", "github.com"],
    ["renamed account", "github.com"],
    ["renamed account", "git.example.test"],
  ])("returns canonical %s identity on %s without a receipt or writes", async (variant, host) => {
    const renamed = variant === "renamed account";
    const repository = renamed ? "mona-cat_octo/.repo.._" : "example/repository";
    const login = renamed ? "mona-cat_octo" : "contributor";
    const f = await fixture({ host, repository, login });
    f.baseRepo.private = renamed;
    if (variant === "same repository") {
      f.pr.head.repo = f.baseRepo;
    }
    const before = session();
    const result = await f.invoke();
    expect(Value.Check(SessionGitHubPullRequestInspectResultSchema, result)).toBe(true);
    expect(result).toMatchObject({
      state: "open",
      url: `https://${host}/${repository}/pull/7`,
      author: { accountId: 101, login },
      base: { repository, repositoryId: 10, branch: "release", commit: BASE },
      head: {
        repository: variant === "same repository" ? repository : "contributor/repository",
        repositoryId: variant === "same repository" ? 10 : 20,
        branch: "topic/existing",
        commit: HEAD,
      },
    });
    if (renamed) {
      expect(f.endpoints()).toContain(`repos/${repository}/collaborators/${login}/permission`);
    }
    expect(session()).toEqual(before);
    expect(f.externalWrites).toEqual([]);
  });

  it.each(["public", "unavailable lookup", "malformed lookup"])(
    "checks another verified linked account with %s",
    async (scenario) => {
      const f = await fixture();
      await syncCanonicalGitHubIdentity({
        identity: { accountId: 202, login: "secondary" },
        authenticationAlias: { kind: "email", email: "secondary@example.test" },
      });
      await linkCanonicalUserProfileEmail("secondary@example.test", f.guestProfile);
      f.pr.user = { id: 202, login: "secondary" };
      if (scenario !== "public") {
        f.baseRepo.private = true;
        f.setAccess("read", 202);
        overrideCommands((argv) => {
          if (argv[0] === "gh" && argv.includes("GET") && argv.at(-1) === "user/101") {
            return commandResult(
              scenario === "malformed lookup" ? "{" : "",
              scenario === "malformed lookup" ? 0 : 1,
            );
          }
          return undefined;
        });
      }
      if (scenario === "malformed lookup") {
        await expect(f.invoke()).rejects.toThrow("The PR could not be verified as yours");
        expect(f.endpoints()).not.toContain("repos/example/repository/pulls/7");
      } else {
        expect(await f.invoke()).toMatchObject({ author: { accountId: 202, login: "secondary" } });
      }
      if (scenario !== "public") {
        expect(mocks.runCommand.mock.calls.some(([argv]) => argv.at(-1) === "user/101")).toBe(true);
      }
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each(
    [false, true].flatMap((enabled) => ["before", "during"].map((timing) => ({ enabled, timing }))),
  )(
    "preserves verified identity and own-PR checks with credit $enabled $timing inspection",
    async ({ enabled, timing }) => {
      const f = await fixture();
      const before = getUserProfileListItem(f.guestProfile);
      // Start at the opposite value so every case changes consent, including opt-in.
      await expect(
        setCanonicalUserPreferences(f.guestProfile, {
          [GIT_COAUTHOR_PREFERENCE_KEY]: !enabled,
        }),
      ).resolves.toMatchObject({ ok: true });
      let changed = false;
      const toggle = async () => {
        await expect(
          setCanonicalUserPreferences(f.guestProfile, {
            [GIT_COAUTHOR_PREFERENCE_KEY]: enabled,
          }),
        ).resolves.toMatchObject({ ok: true });
        changed = true;
      };
      if (timing === "before") {
        await toggle();
      } else {
        f.onRead(async (endpoint) => {
          if (!changed && endpoint.endsWith("/pulls/7")) {
            await toggle();
          }
        });
      }
      if (timing === "during") {
        await expect(f.invoke()).rejects.toThrow(
          "Authenticated profile verification is unavailable",
        );
      }
      // Consent invalidates a prepared request, not the verified identity or a fresh ownership check.
      expect(await f.invoke()).toMatchObject({ author: { accountId: 101, login: "contributor" } });
      expect(changed).toBe(true);
      expect(getUserProfileListItem(f.guestProfile)).toEqual(before);
      f.pr.user.id = 999;
      await expect(f.invoke()).rejects.toThrow("not authored by a GitHub account linked to you");
      expect(f.externalWrites).toEqual([]);
    },
  );

  it.each([false, true])(
    "does not misdiagnose a publisher-authored PR as broken publisher credentials (raw=%s)",
    async (raw) => {
      const f = await fixture();
      f.pr.user = { id: 42, login: "publisher" };
      const before = session();
      await expect(f.invoke({}, raw)).rejects.toThrow(
        "This PR is not authored by a GitHub account linked to you. inspect_pr checks your PR authorship, not the managed publisher's credentials. For a new PR, use publish. A bot-authored PR from another session cannot be imported with inspect_pr or prepare_pr; continue it in the session that published it.",
      );
      expect(session()).toEqual(before);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("rejects an unlinked requester before reading PR data", async () => {
    const f = await fixture({ linked: false });
    await expect(f.invoke()).rejects.toThrow("Link a verified");
    expect(f.requests).toEqual([]);
  });

  it.each(["role", "linked identity", "publisher", "session"])(
    "rejects %s revocation during the PR read",
    async (change) => {
      const f = await fixture();
      let entered = false;
      f.onRead(async (endpoint) => {
        if (!endpoint.endsWith("/pulls/7")) {
          return;
        }
        entered = true;
        if (change === "role") {
          await f.revoke();
        } else if (change === "linked identity") {
          await linkCanonicalUserProfileEmail(
            "publication-guest@example.test",
            f.maintainerProfile,
          );
        } else if (change === "publisher") {
          mocks.matchesIdentity.mockReturnValue(false);
        } else {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: SESSION_KEY },
            { lifecycleRevision: randomUUID() },
          );
        }
      });
      await expect(f.invoke()).rejects.toThrow();
      expect(entered).toBe(true);
      expect(f.endpoints()).not.toContain("repos/contributor/repository");
    },
  );

  it.each(["none", "wrong id", "read"])(
    "qualifies private repository access (%s) before reading the PR",
    async (permission) => {
      const f = await fixture();
      f.baseRepo.private = true;
      f.setAccess(permission === "none" ? "none" : "read", permission === "wrong id" ? 999 : 101);
      if (permission === "read") {
        expect(await f.invoke()).toMatchObject({ author: { accountId: 101 } });
        const endpoints = f.endpoints();
        expect(
          endpoints.indexOf("repos/example/repository/collaborators/contributor/permission"),
        ).toBeLessThan(endpoints.indexOf("repos/example/repository/pulls/7"));
      } else {
        await expect(f.invoke()).rejects.toThrow("could not be verified as yours");
        expect(f.endpoints().some((endpoint) => endpoint.endsWith("/pulls/7"))).toBe(false);
      }
    },
  );

  it("does not expose a private head after the author loses its access", async () => {
    const f = await fixture();
    f.fork.private = true;
    f.setAccess("none");
    await expect(f.invoke()).rejects.toThrow("could not be verified as yours");
    expect(f.externalWrites).toEqual([]);
  });

  it("preserves draft, closed and merged states and an unavailable head", async () => {
    const f = await fixture();
    f.pr.draft = true;
    expect(await f.invoke()).toMatchObject({ state: "draft" });
    f.pr.state = "closed";
    expect(await f.invoke()).toMatchObject({ state: "closed" });
    f.pr.merged = true;
    f.pr.head.repo = null;
    expect(await f.invoke()).toMatchObject({ state: "merged", head: null });
  });

  it.each(["github.com", "git.example.test"])(
    "resolves copied PR views on %s to the same canonical reference",
    async (host) => {
      const f = await fixture({ host });
      const canonical = await f.invoke();
      const endpoints = f.endpoints();
      for (const suffix of [
        "/",
        "/files?diff=split#diff-123",
        "/changes",
        "/commits",
        `/commits/${HEAD}`,
        "/checks?check_run_id=789",
      ]) {
        f.requests.length = 0;
        expect(await f.invoke({ pullRequestUrl: f.pr.html_url + suffix })).toEqual(canonical);
        expect(f.endpoints()).toEqual(endpoints);
      }
    },
  );

  it("keeps enterprise account IDs scoped to the configured host", async () => {
    const f = await fixture({ host: "git.example.test" });
    expect(await f.invoke()).toMatchObject({
      host: "git.example.test",
      author: { accountId: 101 },
    });
    expect(
      f.requests.every((args) => args[args.indexOf("--hostname") + 1] === "git.example.test"),
    ).toBe(true);
    await expect(
      f.invoke({ pullRequestUrl: "https://github.com/example/repository/pull/7" }),
    ).rejects.toThrow("configured GitHub host");
    setRuntimeConfigSnapshot({
      ...f.config,
      gateway: { ...f.config.gateway, github: { host: "other.example.test" } },
    });
    await expect(
      f.invoke({ pullRequestUrl: "https://other.example.test/example/repository/pull/7" }),
    ).rejects.toThrow("Link a verified");
  });

  it("refuses Enterprise aliases without a current proof-validated identity", async () => {
    const host = "git.example.test";
    const f = await fixture({ host, linked: false });
    // Generic admission can bind a principal-shaped alias without Enterprise verification.
    await linkCanonicalUserProfileEmail(`github:${host}:101`, f.guestProfile);
    await expect(f.invoke()).rejects.toThrow("Link a verified");
    // Verification recorded on another profile does not travel with a transferred alias.
    await verifyEnterprise(host, 202, "other", "Other");
    await linkCanonicalUserProfileEmail(`github:${host}:202`, f.guestProfile);
    f.pr.user = { id: 202, login: "other" };
    await expect(f.invoke()).rejects.toThrow("Link a verified");
    expect(f.requests).toEqual([]);
    // Current verification of the guest's own binding admits exactly that account.
    await verifyEnterprise(host);
    f.pr.user = { id: 101, login: "contributor" };
    expect(await f.invoke()).toMatchObject({ host, author: { accountId: 101 } });
    // A verified identity on another Enterprise host neither admits nor disables this host's account.
    await linkCanonicalUserProfileEmail("github:other.example.test:303", f.guestProfile);
    await verifyEnterprise("other.example.test", 303, "contributor-other");
    expect(await f.invoke()).toMatchObject({ host, author: { accountId: 101 } });
    f.pr.user = { id: 303, login: "contributor-other" };
    await expect(f.invoke()).rejects.toThrow("not authored by a GitHub account linked to you");
  });

  it("rejects arbitrary hosts, credential URLs and non-PR paths before network access", async () => {
    const f = await fixture();
    for (const url of [
      "http://github.com/example/repository/pull/7",
      "https://other.test/example/repository/pull/7",
      "https://name:secret@github.com/example/repository/pull/7",
      "https://github.com/example/repository/issues/7",
      "https://github.com:8443/example/repository/pull/7",
      "https://github.com/example/repository/pull/7/other",
      "https://github.com/example/repository/pull/7/commits/not-a-commit",
      "https://github.com/-example/repository/pull/7",
      "https://github.com/example/repository.git/pull/7",
      "https://github.com/example/repository.atom/pull/7",
      "https://github.com/example/repo%2Fother/pull/7",
      "https://github.com/example/repo%ZZ/pull/7",
      `https://github.com/${"a".repeat(40)}/repository/pull/7`,
      `https://github.com/example/${"a".repeat(101)}/pull/7`,
      "https://github.com/example/repository/pull/9007199254740992",
      "https://github.com/example/repository/pull/0",
    ]) {
      await expect(f.invoke({ pullRequestUrl: url })).rejects.toThrow("pull request URL");
    }
    expect(f.requests).toEqual([]);
  });

  it("keeps admin inspection protected and rejects unrelated fields through both entry points", async () => {
    const f = await fixture();
    for (const raw of [false, true]) {
      for (const extra of [
        { publishingSessionKey: "child" },
        { requestId: randomUUID() },
        { title: "change" },
        { mergeMethod: "merge" },
        { token: "synthetic" },
      ]) {
        await expect(f.invoke(extra, raw)).rejects.toThrow();
      }
      await expect(
        f.invoke({ action: "inspect", pullRequestUrl: undefined }, raw),
      ).rejects.toThrow();
    }
    expect(f.requests).toEqual([]);
  });
});
