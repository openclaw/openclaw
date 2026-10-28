// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { createRealPublicationWorkspace } from "./github-publication-git.test-support.js";
import {
  createRequesterPolicyFixture,
  capturePublicationGuest,
  createRequesterPublicationFixture,
  holdWorkerTurn,
} from "./github-publication-requester.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";

const mocks = githubPublicationTestMocks();
const execFileAsync = promisify(execFile);
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
type Backend = Parameters<typeof fixture>[0];
const isPullCreation = (argv: string[]) =>
  argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"));
const published = (url: string, headCommit: string) => ({ status: "published", url, headCommit });

async function prepareExistingPullRequest(
  backend: Backend,
  { changeWorkspace = true }: { changeWorkspace?: boolean } = {},
) {
  const f = await fixture(backend);
  const first = await f.coordinator.requestForSessionV2(f.request("first-publication", f.guest));
  if (first.status !== "published") {
    throw new Error("The original fixture publication did not complete.");
  }
  const created = mocks.runCommand.mock.calls.findLast(([argv]) => isPullCreation(argv));
  const receipt = f.readReceipt(first.requestId)!;
  const pullRequest = f.repository?.runtime.pr ?? {
    url: first.url,
    userId: receipt.identity_account_id,
    state: "open",
    body: JSON.parse(created![1].input).body,
    headSha: first.headCommit,
    headRef: receipt.branch,
    baseRef: receipt.base_branch!,
  };
  expect(pullRequest.body).toContain(`<!-- openclaw-publication:${first.requestId} -->`);
  if (changeWorkspace) {
    if (f.local) {
      await fs.writeFile(path.join(f.local.cwd, "artifact.txt"), "accepted second publication\n");
    } else {
      await f.repository!.capture("accepted second publication\n", "second-publication");
    }
  }
  return {
    f,
    first,
    pullRequest,
    transport: mocks.runCommand.getMockImplementation()!,
    observePush: async () => {
      pullRequest.headSha = f.local
        ? await f.local.git("rev-parse", "HEAD")
        : f.repository!.runtime.head!;
      expect(pullRequest.headSha).not.toBe(first.headCommit);
    },
  };
}

installGitHubPublicationTestHarness({
  creatorEmail: "publication-guest@example.test",
  sandbox: "required",
  realWorktree: true,
});

it("recovers independent worktrees while preserving each worktree's publication order", async ({
  signal,
}) => {
  vi.stubEnv("GIT_AUTHOR_DATE", "2026-10-27T00:00:00Z");
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-10-27T00:00:00Z");
  const first = await fixture("local");
  const firstWorktree = mocks.findWorktree("session", first.session.sessionKey);
  const firstTransport = mocks.runCommand.getMockImplementation()!;
  const secondSession = {
    sessionId: "session-publication",
    sessionKey: "agent:main:dashboard:independent-publication",
  };
  await persistPublicationTestSession(secondSession.sessionKey);
  const secondRoot = path.join(root, "independent");
  await fs.mkdir(secondRoot);
  mocks.findWorktree.mockReturnValue({
    ...firstWorktree,
    id: "independent-worktree",
    ownerId: secondSession.sessionKey,
    branch: "openclaw/independent-publication",
    repoFingerprint: "independent-fingerprint",
  });
  await createRealPublicationWorkspace({
    root: secondRoot,
    branch: "openclaw/independent-publication",
    sessionKey: secondSession.sessionKey,
    realWorktree: true,
    mocks,
    commandResult,
  });
  const secondWorktree = mocks.findWorktree("session", secondSession.sessionKey);
  const { id: secondWorktreeId, branch, repoRoot } = secondWorktree;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: secondSession.sessionKey },
    { worktree: { id: secondWorktreeId, branch, repoRoot } },
  );
  const secondTransport = mocks.runCommand.getMockImplementation()!;
  const second = await createRequesterPolicyFixture(secondSession);
  mocks.findWorktree.mockImplementation((_kind, ownerId) =>
    ownerId === first.session.sessionKey ? firstWorktree : secondWorktree,
  );
  mocks.findWorktreeById.mockImplementation((id) =>
    id === firstWorktree.id ? firstWorktree : secondWorktree,
  );
  mocks.resolveRepository.mockImplementation(async (cwd) => {
    const worktree = cwd === first.local!.cwd ? firstWorktree : secondWorktree;
    return {
      checkoutRoot: cwd,
      repoRoot: cwd,
      fingerprint: worktree.repoFingerprint,
      originUrl: "git@github.com:openclaw/openclaw.git",
    };
  });
  const firstDispatched = Promise.withResolvers<void>();
  const independentDispatched = Promise.withResolvers<void>();
  const firstResponse = Promise.withResolvers<void>();
  const titles: string[] = [];
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { cwd?: string; input?: string }) => {
      if (isPullCreation(argv)) {
        const title = JSON.parse(options!.input!).title as string;
        titles.push(title);
        if (title === "first") {
          firstDispatched.resolve();
          await firstResponse.promise;
        } else if (title === "independent") {
          independentDispatched.resolve();
        }
      }
      return await (options?.cwd === first.local!.cwd ? firstTransport : secondTransport)(
        argv,
        options,
      );
    },
  );
  for (const session of [first.session, secondSession]) {
    await first.placements.startDispatch({
      ...session,
      agentId: "main",
      executionMode: "worker-turn",
    });
  }
  const firstGuest = await capturePublicationGuest(first);
  const secondGuest = await capturePublicationGuest(second);
  const requests = [
    await first.coordinator.requestForSessionV2(first.request("first", firstGuest.requester)),
    await first.coordinator.requestForSessionV2(first.request("next", firstGuest.requester)),
    await first.coordinator.requestForSessionV2({
      ...first.request("independent", secondGuest.requester),
      sessionKey: secondSession.sessionKey,
    }),
  ];
  expect(requests.map(({ status }) => status)).toEqual(["requested", "requested", "requested"]);
  const recovery = first.coordinator.resumeSessionRequests();
  try {
    await withinTest(Promise.race([firstDispatched.promise, recovery]), signal);
    await withinTest(Promise.race([independentDispatched.promise, recovery]), signal);
    expect(titles).toContain("independent");
    expect(titles).not.toContain("next");
  } finally {
    firstResponse.resolve();
    await recovery;
  }
  for (const { requestId } of requests) {
    expect(first.readReceipt(requestId)?.status).toBe("published");
  }
  const calls = mocks.runCommand.mock.calls.length;
  await first.restart().resumeSessionRequests();
  expect(mocks.runCommand.mock.calls.slice(calls).filter(([argv]) => argv[0] === "gh")).toEqual([]);
});

it.each(["local", "repository"] as const)(
  "settles the accepted %s publication before stopping recovery between requests",
  async (backend) => {
    const f = await fixture(backend);
    const claim = await holdWorkerTurn(f);
    const requests = [
      await f.coordinator.requestForSessionV2(f.request("shutdown-first", f.guest)),
      await f.coordinator.requestForSessionV2(f.request("shutdown-second", f.guest)),
    ];
    expect(requests.map((request) => request.status)).toEqual(["requested", "requested"]);
    await f.placements.releaseTurn(claim);

    const dispatched = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const transport = mocks.runCommand.getMockImplementation()!;
    let stopping = false;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const result = await transport(argv, options);
      if (isPullCreation(argv)) {
        dispatched.resolve();
        await response.promise;
      }
      return result;
    });

    const recovery = f.coordinator.resumeSessionRequests(() => stopping);
    await dispatched.promise;
    stopping = true;
    response.resolve();
    await recovery;

    expect(f.publishedTitles).toHaveLength(1);
    expect(
      requests
        .map((request) => f.readReceipt(request.requestId)?.status)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["published", "requested"]);
  },
);

it.each([
  { backend: "local", mode: "paged" },
  { backend: "local", mode: "interrupted" },
  { backend: "repository", mode: "paged" },
  { backend: "repository", mode: "interrupted" },
] as const)(
  "reconciles a $mode $backend update after authority ends",
  async ({ backend, mode }) => {
    const { f, first, pullRequest, transport, observePush } =
      await prepareExistingPullRequest(backend);
    const closed = Array.from({ length: 30 }, (_, index) => ({
      ...pullRequest,
      url: pullRequest.url.replace(/\d+$/u, String(100 + index)),
      state: "closed",
      body: `<!-- openclaw-publication:earlier-closed-${index} -->`,
    }));
    let pushed = false,
      readbackAvailable = false,
      recoveryLookup = false,
      unavailableLookups = 0;
    let acceptedWrites: string[] = [];
    const hostScans = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
    let recoveryScanStart = 0;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("state=all")) {
        recoveryLookup ||= pushed;
        if (mode === "paged") {
          // gh emits one array per page; the matching open PR is beyond page one.
          return commandResult(
            [closed, ...(argv.includes("--paginate") ? [[pullRequest]] : [])]
              .map((page) => JSON.stringify(page))
              .join("\n"),
          );
        }
        if (pushed && !readbackAvailable) {
          unavailableLookups++;
          return commandResult("", 1);
        }
        return commandResult(JSON.stringify([pullRequest]));
      }
      const response = await transport(argv, options);
      if (argv.includes("push") || argv.includes("graphql")) {
        await observePush();
        if (mode === "paged") {
          await f.revoke();
        }
        pushed = true;
        recoveryScanStart = hostScans.mock.calls.length;
        acceptedWrites = [...f.externalWrites];
      }
      return response;
    });
    const idempotencyKey = `${mode}-update`;
    const publication = f.coordinator.requestForSessionV2(f.request(idempotencyKey, f.guest));
    let requestId: string;
    if (mode === "paged") {
      const result = await publication;
      expect(result).toMatchObject(published(first.url, pullRequest.headSha));
      expect(result.requestId).not.toBe(first.requestId);
      requestId = result.requestId;
      expect({ pushed, recoveryLookup }).toEqual({ pushed: true, recoveryLookup: true });
      expect(
        hostScans.mock.calls
          .slice(recoveryScanStart)
          .map(([, query]) => query.compile().sql)
          .filter((sql) => /from "github_(?:repository_)?publication_requests"/u.test(sql)),
      ).toEqual([]);
      expect(f.readReceipt(requestId)).toMatchObject({
        status: "published",
        pull_request_url: first.url,
        head_commit: pullRequest.headSha,
      });
      expect(f.externalWrites).toEqual(acceptedWrites);
      expect(f.publishedTitles).toEqual(["first-publication"]);
      await f.restart().resumeSessionRequests();
    } else {
      if (backend === "local") {
        await expect(publication).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
        requestId = readGitHubPublicationRequest(f.database.db, {
          sessionId: f.session.sessionId,
          idempotencyKey,
        })!.request_id;
      } else {
        const result = await publication;
        expect(result.status).toBe("requested");
        requestId = result.requestId;
      }
      expect(pushed).toBe(true);
      expect(unavailableLookups).toBeGreaterThan(0);
      expect(f.readReceipt(requestId)).toMatchObject({
        pull_request_url: null,
        head_commit: pullRequest.headSha,
      });
      expect(pullRequest.body).not.toContain(`<!-- openclaw-publication:${requestId} -->`);
      expect(await f.coordinator.readAsync(first.requestId)).toEqual(first);
      acceptedWrites = [...f.externalWrites];
      // Closing the known PR cannot undo an accepted update.
      pullRequest.state = "closed";
      await f.revoke();
      expect(f.guest.assertCurrent).toThrow();
      readbackAvailable = true;
      const restarted = f.restart();
      const read = stateReads.executeExistingOpenClawStateRead;
      const unavailableRead = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation((options, command, readOptions) =>
          command.type === "githubPublication.knownPullRequestUrls" ||
          command.type === "githubRepository.knownPullRequestUrls"
            ? Promise.reject(new Error("receipt worker unavailable"))
            : read(options, command, readOptions),
        );
      const pendingReceipt = f.readReceipt(requestId)!;
      try {
        await expect(restarted.resumeSessionRequests()).rejects.toThrow("unconfirmed");
        expect(f.readReceipt(requestId)).toMatchObject({
          status: expect.stringMatching(/^(requested|publishing)$/u),
          request_digest: pendingReceipt.request_digest,
          head_commit: pendingReceipt.head_commit,
          pull_request_url: null,
        });
        expect(f.externalWrites).toEqual(acceptedWrites);
      } finally {
        unavailableRead.mockRestore();
      }
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(requestId)).toMatchObject(
        published(first.url, pullRequest.headSha),
      );
    }
    expect(await f.coordinator.readAsync(first.requestId)).toEqual(first);
    expect(f.externalWrites).toEqual(acceptedWrites);
    expect(f.publishedTitles).toEqual(["first-publication"]);
  },
);

it.each(["local", "repository"] as const)(
  "settles an accepted update on a closed PR with retained %s authority",
  async (backend) => {
    const { f, first, pullRequest, transport, observePush } =
      await prepareExistingPullRequest(backend);
    let pushed = false;
    let readbackAvailable = false;
    let unavailableLookups = 0;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("state=all")) {
        if (pushed && !readbackAvailable) {
          unavailableLookups++;
          return commandResult("", 1);
        }
        return commandResult(JSON.stringify([pullRequest]));
      }
      const response = await transport(argv, options);
      if (argv.includes("push") || argv.includes("graphql")) {
        await observePush();
        pushed = true;
      }
      return response;
    });

    const idempotencyKey = "retained-authority-closed-update";
    const publication = f.coordinator.requestForSessionV2(f.request(idempotencyKey, f.guest));
    let requestId: string;
    if (backend === "local") {
      await expect(publication).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
      requestId = readGitHubPublicationRequest(f.database.db, {
        sessionId: f.session.sessionId,
        idempotencyKey,
      })!.request_id;
    } else {
      const result = await publication;
      expect(result.status).toBe("requested");
      requestId = result.requestId;
    }
    expect(pushed).toBe(true);
    expect(unavailableLookups).toBeGreaterThan(0);
    expect(f.guest.assertCurrent).not.toThrow();
    expect(f.readReceipt(requestId)).toMatchObject({
      pull_request_url: null,
      head_commit: pullRequest.headSha,
    });
    const acceptedWrites = [...f.externalWrites];

    pullRequest.state = "closed";
    readbackAvailable = true;
    await f.restart().resumeSessionRequests();
    expect(f.readReceipt(requestId)).toMatchObject({
      status: "published",
      pull_request_url: first.url,
      head_commit: pullRequest.headSha,
    });
    expect(f.externalWrites).toEqual(acceptedWrites);
  },
);

it("creates a new local publication request with unchanged content after its original PR closes", async () => {
  const { f, pullRequest, transport } = await prepareExistingPullRequest("local", {
    changeWorkspace: false,
  });
  pullRequest.state = "closed";
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv.includes("state=all")) {
      return commandResult(JSON.stringify([pullRequest]));
    }
    return transport(argv, options);
  });

  const beforeNewRequest = mocks.runCommand.mock.calls.length;
  const publication = await f.coordinator.requestForSessionV2(
    f.request("new-publication-after-closure", f.guest),
  );
  expect(publication.status).toBe("published");
  expect(
    mocks.runCommand.mock.calls.slice(beforeNewRequest).filter(([argv]) => isPullCreation(argv)),
  ).toHaveLength(1);
});

it("allows fresh creation after restart reconciles an interrupted closed update", async () => {
  const { f, first, pullRequest, transport, observePush } =
    await prepareExistingPullRequest("local");
  let pushed = false;
  let readbackAvailable = true;
  let phase = "update";
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv.includes("state=all")) {
      return pushed && !readbackAvailable
        ? commandResult("", 1)
        : commandResult(JSON.stringify([pullRequest]));
    }
    const response = await transport(argv, options);
    if (argv.includes("push") || argv.includes("graphql")) {
      await observePush();
      pushed = true;
      if (phase === "update") {
        readbackAvailable = false;
      }
    }
    return response;
  });

  const idempotencyKey = "interrupted-closed-update-then-fresh-request";
  const publication = f.coordinator.requestForSessionV2(f.request(idempotencyKey, f.guest));
  await expect(publication).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
  const requestId = readGitHubPublicationRequest(f.database.db, {
    sessionId: f.session.sessionId,
    idempotencyKey,
  })!.request_id;
  const acceptedWrites = [...f.externalWrites];

  pullRequest.state = "closed";
  readbackAvailable = true;
  phase = "restart";
  await f.restart().resumeSessionRequests();
  expect(f.readReceipt(requestId)).toMatchObject({
    status: "published",
    pull_request_url: first.url,
    head_commit: pullRequest.headSha,
  });
  expect(f.externalWrites).toEqual(acceptedWrites);

  phase = "fresh-request";
  const beforeFreshRequest = mocks.runCommand.mock.calls.length;
  const fresh = await f.coordinator.requestForSessionV2(
    f.request("fresh-after-interrupted-closed-update", f.guest),
  );
  expect(fresh.status).toBe("published");
  expect(
    mocks.runCommand.mock.calls.slice(beforeFreshRequest).filter(([argv]) => isPullCreation(argv)),
  ).toHaveLength(1);
});

it.skipIf(!process.env.OPENCLAW_GH_CLI_PATH)(
  "recovers an interrupted closed update through the real gh client and preserves fresh creation",
  async () => {
    const { f, first, pullRequest, transport, observePush } =
      await prepareExistingPullRequest("local");
    const trace: string[] = [];
    let phase = "update";
    let pushed = false;
    let readbackAvailable = true;
    const proofDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gh-e2e-"));
    const keyPath = path.join(proofDirectory, "gateway.key");
    const certificatePath = path.join(proofDirectory, "gateway.crt");
    const configDirectory = path.join(proofDirectory, "config");
    await fs.mkdir(configDirectory);
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ]);
    const https = await import("node:https");
    const server = https.createServer(
      {
        key: await fs.readFile(keyPath),
        cert: await fs.readFile(certificatePath),
      },
      (req, res) => {
        const pathname = new URL(req.url ?? "/", "https://localhost").pathname;
        req.resume();
        req.on("end", () => {
          const send = (status: number, value: unknown) => {
            const body = JSON.stringify(value);
            res.writeHead(status, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            });
            res.end(body);
          };
          const auth = req.headers.authorization ? "[redacted]" : "none";
          if (req.method === "GET" && pathname === "/repos/openclaw/openclaw/pulls") {
            const status = pushed && !readbackAvailable ? 503 : 200;
            trace.push(`${phase} GET ${pathname} status=${status} Authorization=${auth}`);
            return status === 503
              ? send(status, { message: "fixture readback temporarily unavailable" })
              : send(status, [
                  {
                    html_url: pullRequest.url,
                    user: { id: pullRequest.userId },
                    state: pullRequest.state,
                    body: pullRequest.body,
                    head: { sha: pullRequest.headSha, ref: pullRequest.headRef },
                    base: { ref: pullRequest.baseRef },
                  },
                ]);
          }
          if (req.method === "POST" && pathname === "/repos/openclaw/openclaw/pulls") {
            trace.push(
              `${phase} POST ${pathname} status=201 Authorization=${auth} body=[redacted]`,
            );
            return send(201, { html_url: "https://github.com/openclaw/openclaw/pull/1000" });
          }
          trace.push(`${phase} ${req.method ?? "?"} ${pathname} status=404 Authorization=${auth}`);
          return send(404, { message: "fixture route not found" });
        });
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("The local GitHub API fixture did not bind to a TCP port.");
    }
    await fs.writeFile(
      path.join(configDirectory, "hosts.yml"),
      "github.com:\n    api_host: localhost:" + address.port + "\n",
    );
    const ghCliDirectory = path.dirname(process.env.OPENCLAW_GH_CLI_PATH!);
    const persistTrace = async () => {
      const tracePath = process.env.OPENCLAW_GH_E2E_TRACE_FILE;
      if (tracePath) {
        await fs.writeFile(tracePath, trace.join("\n") + "\n");
      }
    };
    const apiEnv: NodeJS.ProcessEnv = {
      PATH: [ghCliDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
      HOME: process.env.HOME ?? proofDirectory,
      GH_CONFIG_DIR: configDirectory,
      GH_TOKEN: "fixture-only-token",
      SSL_CERT_FILE: certificatePath,
    };
    mocks.prepareIdentity.mockResolvedValue({
      source: "system-configured",
      profileId: "fixture-profile",
      account: { accountId: pullRequest.userId, login: "fixture-bot", avatarUrl: null },
      env: apiEnv,
    });
    const { runCommandBuffered: runReal } =
      await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
    mocks.runCommand.mockImplementation(
      async (argv: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) => {
        if (argv[0] === "gh" && (argv.includes("state=all") || isPullCreation(argv))) {
          return await runReal(argv, { ...options, env: { ...apiEnv, ...options?.env } });
        }
        const response = await transport(argv, options);
        if (argv.includes("push") || argv.includes("graphql")) {
          await observePush();
          pushed = true;
          if (phase === "update") {
            readbackAvailable = false;
          }
        }
        return response;
      },
    );

    try {
      const publication = f.coordinator.requestForSessionV2(
        f.request("real-client-interrupted-update", f.guest),
      );
      await expect(publication).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
      expect(pushed).toBe(true);
      expect(
        trace.some((entry) => entry.startsWith("update GET") && entry.includes("status=503")),
      ).toBe(true);
      expect(trace.some((entry) => entry.includes("POST /repos/openclaw/openclaw/pulls"))).toBe(
        false,
      );

      pullRequest.state = "closed";
      readbackAvailable = true;
      phase = "restart";
      const beforeRestart = trace.length;
      const requestId = readGitHubPublicationRequest(f.database.db, {
        sessionId: f.session.sessionId,
        idempotencyKey: "real-client-interrupted-update",
      })!.request_id;
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(requestId)).toMatchObject({
        status: "published",
        url: first.url,
      });
      expect(
        trace
          .slice(beforeRestart)
          .filter((entry) => entry.includes("POST /repos/openclaw/openclaw/pulls")),
      ).toHaveLength(0);

      phase = "fresh-request";
      const beforeFresh = trace.length;
      const fresh = await f.coordinator.requestForSessionV2(
        f.request("real-client-fresh-after-close", f.guest),
      );
      expect(fresh).toMatchObject({
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/1000",
      });
      expect(
        trace
          .slice(beforeFresh)
          .filter((entry) => entry.includes("POST /repos/openclaw/openclaw/pulls")),
      ).toHaveLength(1);
      await persistTrace();
    } finally {
      await persistTrace();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(proofDirectory, { recursive: true, force: true });
    }
  },
);
