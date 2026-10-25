import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { syncCanonicalGitHubIdentity } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { prepareControlUiSessionPrServiceTarget } from "./control-ui-session-pr-read.js";
import { githubJson, requestUrl } from "./control-ui-session-prs.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

const io = vi.hoisted(() => ({ command: vi.fn(), identity: vi.fn(), currentIdentity: vi.fn() }));
vi.mock("../agents/github-tool-identity.js", async (original) => ({
  ...(await original<typeof import("../agents/github-tool-identity.js")>()),
  prepareGitHubPublicationIdentity: io.identity,
  matchesPreparedGitHubPublicationIdentity: io.currentIdentity,
}));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runCommandBuffered: io.command,
}));

const headCommit = "a".repeat(40);
const baseCommit = "b".repeat(40);
const worktree = {
  id: "own-imported-source",
  branch: "openclaw/local-task",
  repoRoot: "/synthetic/repository",
  githubPullRequest: {
    url: "https://github.com/example/repository/pull/7",
    host: "github.com",
    number: 7,
    base: {
      repository: "example/repository",
      repositoryId: 10,
      branch: "main",
      commit: baseCommit,
    },
    head: {
      repository: "contributor/repository",
      repositoryId: 20,
      branch: "original",
      commit: headCommit,
    },
    preparedHeadCommit: headCommit,
  },
};

function frames(f: Awaited<ReturnType<typeof createFixture>>) {
  return f.socket.send.mock.calls.map(([data]) => JSON.parse(data.toString()));
}
function lastSnapshot(f: Awaited<ReturnType<typeof createFixture>>) {
  return frames(f).findLast((frame) => frame.event === "controlUi.sessionPullRequests.changed")
    ?.payload.sessions[sessionKey];
}

async function readChecks(f: Awaited<ReturnType<typeof createFixture>>, respond = vi.fn()) {
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "own-checks",
      method: "controlUi.sessionPullRequests.checks",
      params: {
        sessionKey,
        owner: "example",
        repo: "repository",
        number: 7,
        headSha: headCommit,
      },
    },
    client: f.client,
    context: f.context,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function withOwnFixture(
  run: (
    f: Awaited<ReturnType<typeof createFixture>>,
    remote: {
      pr: Record<string, unknown>;
      base: { private: boolean };
      setPermission: (permission: string) => void;
      beforeRead: (callback: () => Promise<void>) => void;
      fetch: ReturnType<typeof vi.fn<typeof fetch>>;
    },
  ) => Promise<void>,
  scope: "operator.read" | "operator.sessions.write" = "operator.sessions.write",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await createFixture(scope, true);
    let permission = "read";
    let before: (() => Promise<void>) | undefined;
    const base = {
      id: 10,
      full_name: "example/repository",
      name: "repository",
      owner: { login: "example" },
      private: false,
    };
    const fork = { id: 20, full_name: "contributor/repository", private: false };
    const pr = {
      number: 7,
      html_url: worktree.githubPullRequest.url,
      title: "Original contribution",
      user: { id: 101, login: "contributor" },
      state: "closed",
      draft: false,
      merged: false,
      base: { repo: base, ref: "main", sha: baseCommit },
      head: { repo: fork, ref: "original", sha: headCommit },
    };
    io.identity.mockResolvedValue({
      source: "system-detected",
      host: "github.com",
      env: { GH_TOKEN: "synthetic-own-pr-read-token" },
      account: { accountId: 42, login: "publisher" },
    });
    io.currentIdentity.mockReturnValue(true);
    io.command.mockImplementation(async (argv: string[]) => {
      if (argv[0] !== "gh" || !argv.includes("GET")) {
        throw new Error("Unexpected non-read operation");
      }
      await before?.();
      const endpoint = argv.at(-1);
      const value =
        endpoint === "repos/example/repository"
          ? base
          : endpoint === "repos/contributor/repository"
            ? fork
            : endpoint === "repos/example/repository/pulls/7"
              ? pr
              : endpoint === "user/101"
                ? pr.user
                : endpoint === "repos/example/repository/collaborators/contributor/permission"
                  ? { user: pr.user, permission }
                  : undefined;
      return {
        code: value ? 0 : 1,
        signal: null,
        killed: false,
        stdout: Buffer.from(JSON.stringify(value ?? {})),
        stderr: Buffer.alloc(0),
      };
    });
    vi.stubEnv("GH_TOKEN", "synthetic-unrelated-service-token");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        scope === "operator.read"
          ? "Bearer synthetic-unrelated-service-token"
          : "Bearer synthetic-own-pr-read-token",
      );
      const url = new URL(requestUrl(input));
      if (url.pathname === `/repos/example/repository/commits/${headCommit}/check-runs`) {
        return githubJson({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: "Original checks",
              head_sha: headCommit,
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      }
      expect(url.href).toBe("https://api.github.com/repos/example/repository/pulls/7");
      return githubJson(pr);
    });
    vi.stubGlobal("fetch", fetch);
    io.command.mockClear();
    try {
      await run(f, {
        pr,
        base,
        fetch,
        setPermission: (value) => {
          permission = value;
        },
        beforeRead: (callback) => {
          before = callback;
        },
      });
    } finally {
      await f.close();
    }
  });
}

it("does not hydrate public or service cards from an authenticated imported snapshot", async () => {
  await withOwnFixture(async (f) => {
    await f.seed(sessionKey, f.profile.id, { worktree });
    await f.subscribe();
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)?.pullRequests).toHaveLength(1);
    const service = await prepareControlUiSessionPrServiceTarget(
      () => getSessionRowProjection(f.context),
      { sessionKey, agentId: "main" },
    );
    expect(service).toBeDefined();
    if (!service) {
      throw new Error("Missing service fixture target");
    }
    expect(f.subscriptions.readPrepared(service, () => false)?.pullRequests ?? []).toEqual([]);
  }, "operator.read");
});

it("keeps the verified card without counts when the check read is rate limited", async () => {
  await withOwnFixture(async (f, remote) => {
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "contributor" },
      authenticationAlias: { kind: "email", email: f.readerEmail },
    });
    remote.pr.state = "open";
    const served = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementation(async (input, init) =>
      new URL(requestUrl(input)).pathname.endsWith("/check-runs")
        ? githubJson({ message: "API rate limit exceeded" }, 429)
        : served!(input, init),
    );
    await f.seed(sessionKey, f.profile.id, { worktree });
    await f.subscribe();
    await f.subscriptions.pollNow();
    expect(
      remote.fetch.mock.calls.some(([input]) =>
        new URL(requestUrl(input)).pathname.endsWith("/check-runs"),
      ),
    ).toBe(true);
    const snapshot = lastSnapshot(f);
    expect(snapshot?.pullRequests).toHaveLength(1);
    expect(snapshot?.pullRequests[0]).toMatchObject({
      number: 7,
      state: "open",
      url: worktree.githubPullRequest.url,
    });
    expect(snapshot?.pullRequests[0]).not.toHaveProperty("checks");
    expect(snapshot).toMatchObject({ rateLimited: true });
    expect(snapshot).not.toHaveProperty("discardPrevious");
  });
});

it("admits only the prepared own binding and clears withdrawn private/profile access", async ({
  signal,
}) => {
  await withOwnFixture(async (f, remote) => {
    for (const binding of [
      undefined,
      {
        ...worktree,
        githubPullRequest: { ...worktree.githubPullRequest, preparedHeadCommit: undefined },
      },
      worktree,
    ]) {
      await f.seed(sessionKey, f.profile.id, { worktree: binding });
      await f.subscribe();
      await f.subscriptions.pollNow();
      expect(remote.fetch).not.toHaveBeenCalled();
      expect(io.command).not.toHaveBeenCalled();
    }
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "contributor" },
      authenticationAlias: { kind: "email", email: f.readerEmail },
    });
    remote.pr.user = { id: 999, login: "other" };
    await f.subscribe();
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)).toMatchObject({ pullRequests: [], discardPrevious: true });
    expect(remote.fetch).not.toHaveBeenCalled();
    remote.pr.user = { id: 101, login: "contributor" };
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)?.pullRequests).toMatchObject([
      { number: 7, state: "closed", branch: "original" },
    ]);
    await f.subscriptions.pollNow();
    // Own-PR authorization is refreshed by the bounded load, never watcher rechecks.
    const reads = io.command.mock.calls.length;
    expect(remote.fetch).not.toHaveBeenCalled();
    const foreign = "agent:main:foreign-import";
    await f.seed(foreign, f.other.id, { worktree });
    await f.subscribe([foreign]);
    await f.subscriptions.pollNow();
    expect(io.command).toHaveBeenCalledTimes(reads);
    await f.subscribe();
    await f.subscriptions.pollNow();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 91_000);
    remote.base.private = true;
    remote.setPermission("none");
    f.socket.send.mockClear();
    const metadataReads = remote.fetch.mock.calls.length;
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)).toMatchObject({ pullRequests: [], discardPrevious: true });
    expect(remote.fetch).toHaveBeenCalledTimes(metadataReads);

    remote.setPermission("read");
    remote.pr.state = "open";
    vi.setSystemTime(Date.now() + 91_000);
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)?.pullRequests).toHaveLength(1);
    expect(lastSnapshot(f)?.pullRequests[0].checks).toMatchObject({ state: "passing", passed: 1 });
    const respond = await readChecks(f);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "ready",
        checks: [expect.objectContaining({ name: "Original checks" })],
      }),
      undefined,
    );
    f.socket.send.mockClear();
    const invalidated = createDeferredCore();
    f.socket.send.mockImplementation((data) => {
      const frame = JSON.parse(data.toString());
      if (frame.event === "sessions.changed" && frame.payload.reason === "profile-identity") {
        invalidated.resolve();
      }
    });
    await f.changeReader("profile");
    await withinTest(invalidated.promise, signal);
    expect(frames(f)).toContainEqual(
      expect.objectContaining({
        event: "sessions.changed",
        payload: { reason: "profile-identity" },
      }),
    );
    expect(JSON.stringify(frames(f))).not.toContain("Original contribution");
  });
});

it("keeps cached private facts guarded while another reader refreshes", async ({ signal }) => {
  await withOwnFixture(async (f, remote) => {
    await f.seed(sessionKey, f.profile.id, { worktree });
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "contributor" },
      authenticationAlias: { kind: "email", email: f.readerEmail },
    });
    remote.base.private = true;
    await f.subscribe();
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)?.pullRequests).toHaveLength(1);

    const entered = createDeferredCore();
    const release = createDeferredCore();
    remote.beforeRead(async () => {
      entered.resolve();
      await release.promise;
    });
    const polling = f.subscriptions.pollNow();
    try {
      await awaitGateBeforeSettlement(entered.promise, polling, "Warm refresh was not admitted");
      io.currentIdentity.mockReturnValue(false);
      const second = f.addReader("second-own-pr-reader");
      const delivered = createDeferredCore();
      second.socket.send.mockImplementation((data) => {
        const frame = JSON.parse(data.toString());
        if (
          frame.event === "controlUi.sessionPullRequests.changed" ||
          frame.event === "sessions.changed"
        ) {
          delivered.resolve();
        }
      });
      await f.subscribe([sessionKey], second.client);
      await withinTest(delivered.promise, signal);
      const received = second.socket.send.mock.calls.map(([data]) => JSON.parse(data.toString()));
      expect(JSON.stringify(received)).not.toContain("Original contribution");
      expect(received).toContainEqual(
        expect.objectContaining({
          event: "sessions.changed",
          payload: { reason: "profile-identity" },
        }),
      );
    } finally {
      release.resolve();
      await polling;
    }
  });
});

it.each(["grant", "unsubscribe"] as const)(
  "does not disclose a late own-PR read after %s",
  async (change) => {
    await withOwnFixture(async (f, remote) => {
      await f.seed(sessionKey, f.profile.id, { worktree });
      await syncCanonicalGitHubIdentity({
        identity: { accountId: 101, login: "contributor" },
        authenticationAlias: { kind: "email", email: f.readerEmail },
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      remote.beforeRead(async () => {
        entered.resolve();
        await release.promise;
      });
      try {
        await f.subscribe();
        const polling = f.subscriptions.pollNow();
        await awaitGateBeforeSettlement(
          entered.promise,
          polling,
          "Own imported PR read was not admitted",
        );
        if (change === "grant") {
          await f.changeReader("grant");
        } else {
          f.subscriptions.unsubscribe(f.client.connId!);
        }
        release.resolve();
        await polling;
        expect(remote.fetch).not.toHaveBeenCalled();
        expect(JSON.stringify(frames(f))).not.toContain("Original contribution");
      } finally {
        release.resolve();
      }
    });
  },
);

it.each([
  ["snapshot", "unchanged"],
  ["snapshot", "grant"],
  ["checks", "unchanged"],
  ["checks", "grant"],
  ["checks", "draft"],
] as const)("keeps own-PR %s transport scoped (%s)", async (mode, change) => {
  const retired = change === "grant";
  await withOwnFixture(async (f, remote) => {
    await f.seed(sessionKey, f.profile.id, { worktree });
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 101, login: "contributor" },
      authenticationAlias: { kind: "email", email: f.readerEmail },
    });
    remote.base.private = true;
    remote.pr.state = "open";
    if (mode === "checks") {
      await f.subscribe();
      await f.subscriptions.pollNow();
      expect(lastSnapshot(f)?.pullRequests).toHaveLength(1);
    }
    f.socket.send.mockClear();
    remote.fetch.mockClear();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    remote.fetch.mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-own-pr-read-token",
      );
      const url = new URL(requestUrl(input));
      expect(url.origin + url.pathname).toBe(
        `https://api.github.com/repos/example/repository/commits/${headCommit}/check-runs`,
      );
      const page = Number(url.searchParams.get("page"));
      expect([1, 2]).toContain(page);
      if (page === 1) {
        entered.resolve();
        await release.promise;
      }
      return githubJson({
        total_count: 101,
        check_runs: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
          id: (page - 1) * 100 + index + 1,
          name: `Private transport check ${(page - 1) * 100 + index + 1}`,
          head_sha: headCommit,
          status: "completed",
          conclusion: "success",
        })),
      });
    });
    const respond = vi.fn();
    let pending: Promise<unknown> | undefined;
    try {
      if (mode === "snapshot") {
        await f.subscribe();
      }
      pending = mode === "snapshot" ? f.subscriptions.pollNow() : readChecks(f, respond);
      await awaitGateBeforeSettlement(entered.promise, pending, "Selected transport never started");
      if (retired) {
        await f.changeReader("grant");
      } else if (change === "draft") {
        await f.changeReader("visibility");
      }
      release.resolve();
      await pending;
      expect(remote.fetch).toHaveBeenCalledTimes(retired ? 1 : 2);
      if (retired) {
        expect(JSON.stringify(frames(f))).not.toContain("Original contribution");
        expect(JSON.stringify(frames(f))).not.toContain("Private transport check");
        if (mode === "checks") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          );
        }
      } else if (mode === "snapshot") {
        expect(lastSnapshot(f)?.pullRequests).toMatchObject([
          { title: "Original contribution", checks: { state: "passing", passed: 101 } },
        ]);
      } else {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            status: "ready",
            checks: expect.arrayContaining([
              expect.objectContaining({ id: 101, name: "Private transport check 101" }),
            ]),
          }),
          undefined,
        );
      }
    } finally {
      release.resolve();
      await pending;
    }
  });
});
