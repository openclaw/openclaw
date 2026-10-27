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
function gitRef(repository: string, repositoryId: number, branch: string, commit: string) {
  return { repository, repositoryId, branch, commit };
}
const worktree = {
  id: "own-imported-source",
  branch: "openclaw/local-task",
  repoRoot: "/synthetic/repository",
  githubPullRequest: {
    url: "https://github.com/example/repository/pull/7",
    host: "github.com",
    number: 7,
    base: gitRef("example/repository", 10, "main", baseCommit),
    head: gitRef("contributor/repository", 20, "original", headCommit),
    preparedHeadCommit: headCommit,
  },
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;
function frames(f: Pick<Fixture, "socket">) {
  return f.socket.send.mock.calls.map(([data]) => JSON.parse(data.toString()));
}
function lastSnapshot(f: Fixture) {
  return frames(f).findLast((frame) => frame.event === "controlUi.sessionPullRequests.changed")
    ?.payload.sessions[sessionKey];
}

async function identifyOwner(f: Fixture) {
  await syncCanonicalGitHubIdentity({
    identity: { accountId: 101, login: "contributor" },
    authenticationAlias: { kind: "email", email: f.readerEmail },
  });
}
async function seedOwner(f: Fixture) {
  await f.seed(sessionKey, f.profile.id, { worktree });
  await identifyOwner(f);
}
async function poll(f: Fixture) {
  await f.subscribe();
  await f.subscriptions.pollNow();
}
const identityChanged = expect.objectContaining({
  event: "sessions.changed",
  payload: { reason: "profile-identity" },
});
function readGate() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}
function check(id: number, name: string) {
  return { id, name, head_sha: headCommit, status: "completed", conclusion: "success" };
}
function invalidateOn(f: Pick<Fixture, "socket">, events: string[], reason?: string) {
  const received = createDeferredCore();
  f.socket.send.mockImplementation((data) => {
    const frame = JSON.parse(data.toString());
    if (events.includes(frame.event) && (!reason || frame.payload.reason === reason)) {
      received.resolve();
    }
  });
  return received.promise;
}
async function readChecks(f: Fixture, respond = vi.fn()) {
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
    f: Fixture,
    remote: {
      pr: Record<string, unknown>;
      base: { private: boolean };
      setPermission: (permission: string) => void;
      beforeRead: (callback: () => Promise<void>) => void;
      checks: { count: number; status: number; before?: () => Promise<void> };
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
      const responses: Record<string, unknown> = {
        "repos/example/repository": base,
        "repos/contributor/repository": fork,
        "repos/example/repository/pulls/7": pr,
        "user/101": pr.user,
        "repos/example/repository/collaborators/contributor/permission": {
          user: pr.user,
          permission,
        },
      };
      const value =
        endpoint && Object.hasOwn(responses, endpoint) ? responses[endpoint] : undefined;
      return {
        code: value ? 0 : 1,
        signal: null,
        killed: false,
        stdout: Buffer.from(JSON.stringify(value ?? {})),
        stderr: Buffer.alloc(0),
      };
    });
    vi.stubEnv("GH_TOKEN", "synthetic-unrelated-service-token");
    const checks = {
      count: 1,
      status: 200,
      before: undefined as (() => Promise<void>) | undefined,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        scope === "operator.read"
          ? "Bearer synthetic-unrelated-service-token"
          : "Bearer synthetic-own-pr-read-token",
      );
      const url = new URL(requestUrl(input));
      if (checks.count > 1) {
        expect(url.origin + url.pathname).toBe(
          `https://api.github.com/repos/example/repository/commits/${headCommit}/check-runs`,
        );
      }
      if (url.pathname === `/repos/example/repository/commits/${headCommit}/check-runs`) {
        expect(url.origin).toBe("https://api.github.com");
        if (checks.status !== 200) {
          return githubJson({ message: "API rate limit exceeded" }, checks.status);
        }
        const page = Number(url.searchParams.get("page") ?? (checks.count === 1 ? 1 : null));
        expect([1, 2]).toContain(page);
        if (page === 1) {
          await checks.before?.();
        }
        return githubJson({
          total_count: checks.count,
          check_runs: Array.from(
            { length: Math.min(100, checks.count - (page - 1) * 100) },
            (_, i) => {
              const id = (page - 1) * 100 + i + 1;
              return check(
                id,
                checks.count === 1 ? "Original checks" : `Private transport check ${id}`,
              );
            },
          ),
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
        checks,
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
    await poll(f);
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
    await identifyOwner(f);
    remote.pr.state = "open";
    remote.checks.status = 429;
    await f.seed(sessionKey, f.profile.id, { worktree });
    await poll(f);
    const snapshot = lastSnapshot(f);
    expect(snapshot).toMatchObject({
      rateLimited: true,
      pullRequests: [
        expect.objectContaining({ number: 7, state: "open", url: worktree.githubPullRequest.url }),
      ],
    });
    expect(snapshot?.pullRequests).toHaveLength(1);
    expect(snapshot?.pullRequests[0]).not.toHaveProperty("checks");
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
      await poll(f);
      expect(remote.fetch).not.toHaveBeenCalled();
      expect(io.command).not.toHaveBeenCalled();
    }
    await identifyOwner(f);
    remote.pr.user = { id: 999, login: "other" };
    await poll(f);
    expect(lastSnapshot(f)).toMatchObject({ pullRequests: [], discardPrevious: true });
    expect(remote.fetch).not.toHaveBeenCalled();
    remote.pr.user = { id: 101, login: "contributor" };
    await f.subscriptions.pollNow();
    expect(lastSnapshot(f)?.pullRequests).toMatchObject([
      { number: 7, state: "closed", branch: "original" },
    ]);
    await f.subscriptions.pollNow();
    // Retire the owned watcher before measuring the denied foreign subscription alone.
    await f.subscribe([]);
    await f.subscriptions.pollNow();
    // Own-PR authorization is refreshed by the bounded load, never watcher rechecks.
    const reads = io.command.mock.calls.length;
    expect(remote.fetch).not.toHaveBeenCalled();
    const foreign = "agent:main:foreign-import";
    await f.seed(foreign, f.other.id, { worktree });
    await f.subscribe([foreign]);
    await f.subscriptions.pollNow();
    expect(io.command).toHaveBeenCalledTimes(reads);
    await poll(f);

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
    const invalidated = invalidateOn(f, ["sessions.changed"], "profile-identity");
    await f.changeReader("profile");
    await withinTest(invalidated, signal);
    expect(frames(f)).toContainEqual(identityChanged);
    expect(JSON.stringify(frames(f))).not.toContain("Original contribution");
  });
});

it("keeps cached private facts guarded while another reader refreshes", async ({ signal }) => {
  await withOwnFixture(async (f, remote) => {
    await seedOwner(f);
    remote.base.private = true;
    await poll(f);
    expect(lastSnapshot(f)?.pullRequests).toHaveLength(1);

    const gate = readGate();
    remote.beforeRead(gate.wait);
    const polling = f.subscriptions.pollNow();
    try {
      await awaitGateBeforeSettlement(gate.entered, polling, "Warm refresh was not admitted");
      io.currentIdentity.mockReturnValue(false);
      const second = f.addReader("second-own-pr-reader");
      const delivered = invalidateOn(second, [
        "controlUi.sessionPullRequests.changed",
        "sessions.changed",
      ]);
      await f.subscribe([sessionKey], second.client);
      await withinTest(delivered, signal);
      const received = frames(second);
      expect(JSON.stringify(received)).not.toContain("Original contribution");
      expect(received).toContainEqual(identityChanged);
    } finally {
      gate.release();
      await polling;
    }
  });
});

it.each(["grant", "unsubscribe"] as const)(
  "does not disclose a late own-PR read after %s",
  async (change) => {
    await withOwnFixture(async (f, remote) => {
      await seedOwner(f);
      const gate = readGate();
      remote.beforeRead(gate.wait);
      try {
        await f.subscribe();
        const polling = f.subscriptions.pollNow();
        await awaitGateBeforeSettlement(
          gate.entered,
          polling,
          "Own imported PR read was not admitted",
        );
        if (change === "grant") {
          await f.changeReader("grant");
        } else {
          f.subscriptions.unsubscribe(f.client.connId!);
        }
        gate.release();
        await polling;
        expect(remote.fetch).not.toHaveBeenCalled();
        expect(JSON.stringify(frames(f))).not.toContain("Original contribution");
      } finally {
        gate.release();
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
    await seedOwner(f);
    remote.base.private = true;
    remote.pr.state = "open";
    if (mode === "checks") {
      await poll(f);
      expect(lastSnapshot(f)?.pullRequests).toHaveLength(1);
    }
    f.socket.send.mockClear();
    remote.fetch.mockClear();
    const gate = readGate();
    remote.checks.count = 101;
    remote.checks.before = gate.wait;
    const respond = vi.fn();
    let pending: Promise<unknown> | undefined;
    try {
      if (mode === "snapshot") {
        await f.subscribe();
      }
      pending = mode === "snapshot" ? f.subscriptions.pollNow() : readChecks(f, respond);
      await awaitGateBeforeSettlement(gate.entered, pending, "Selected transport never started");
      if (retired) {
        await f.changeReader("grant");
      } else if (change === "draft") {
        await f.changeReader("visibility");
      }
      gate.release();
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
      gate.release();
      await pending;
    }
  });
});
