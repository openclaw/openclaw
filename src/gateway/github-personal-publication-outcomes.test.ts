import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readPersonalGitHubPublication } from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createForeignPublicationSession,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.js";
import {
  BRANCH,
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createRealPublicationWorkspace,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";

const mocks = githubPublicationTestMocks();
vi.mock("../agents/worktrees/git-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git-lock.js")>()),
  lockWorktreeForProcess: vi.fn(async () => undefined),
  unlockWorktree: vi.fn(async () => undefined),
}));
vi.mock("../process/exec.js", () => ({
  runCommandBuffered: (
    ...args: Parameters<typeof import("../process/exec.js").runCommandBuffered>
  ) => mocks.runCommand(...args),
}));

describe("personal publication definitive outcomes", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc(fixture, method, params);
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation: fixture.generation, account },
  });
  const status = (requestId: string) =>
    fixture.coordinator.personalStatus(
      fixture.action,
      { sessionKey: SESSION_KEY, sessionId: SESSION_ID, agentId: "main" },
      requestId,
    );
  it.each([
    { boundary: "connection closes", readback: false },
    { boundary: "permission ends", readback: false },
    { boundary: "permission ends during readback", readback: true },
  ] as const)(
    "retains an accepted open PR response after the requesting $boundary",
    async ({ boundary, readback }) => {
      const workspace = await createRealPublicationWorkspace();
      const transport = mocks.runCommand.getMockImplementation()!;
      let created = false;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        let response = await transport(argv, options);
        const creating = argv.includes("POST") && argv.includes("repos/openclaw/openclaw/pulls");
        if (creating) {
          created = true;
          if (readback) {
            return commandResult("", 1);
          }
        }
        if (readback && created && argv.includes("state=all")) {
          response = commandResult(
            JSON.stringify([
              {
                url: "https://github.com/openclaw/openclaw/pull/125200",
                userId: account.accountId,
                state: "open",
                body: "",
                headSha: await workspace.git("rev-parse", "HEAD"),
                headRef: BRANCH,
                baseRef: "main",
              },
            ]),
          );
        }
        if (creating || (readback && created && argv.includes("state=all"))) {
          if (boundary === "connection closes") {
            fixture.runtime.live = false;
          } else {
            fixture.client.connect.scopes = ["operator.read"];
          }
        }
        return response;
      });

      const published = await fixture.coordinator.requestPersonalForSession(
        request(),
        fixture.action,
      );

      expect(published).toMatchObject({
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/125200",
      });
      expect(
        readPersonalGitHubPublication(fixture.owner, { requestId: published.requestId }),
      ).toMatchObject({
        status: "published",
        pull_request_url: "https://github.com/openclaw/openclaw/pull/125200",
      });
      await fixture.coordinator.resumeSessionRequests();
      expect(workspace.effects).toEqual(["push", "pull_request"]);
    },
  );

  it("does not resume shared GitHub writes after the RPC request loses write permission", async () => {
    fixture.client.internal = {
      ...fixture.client.internal,
      operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(fixture.owner, fixture.config),
    };
    const workspace = await createRealPublicationWorkspace();
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const response = await transport(argv, options);
      if (argv[0] === "git" && argv.includes("push")) {
        await createForeignPublicationSession(fixture.otherOwner);
      }
      return response;
    });
    const idempotencyKey = "shared-rpc-revoked-after-push";
    const response = await rpc("sessions.github.publish", {
      sessionKey: SESSION_KEY,
      idempotencyKey,
      selection: {
        source: "shared",
        expected: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
      },
    });
    expect(response[0]).toBe(false);
    await fixture.coordinator.resumeSessionRequests();
    expect(workspace.effects).toEqual(["push"]);
    const receipt = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
      sessionId: SESSION_ID,
      idempotencyKey,
    });
    expect(receipt).toMatchObject({
      status: "failed",
      head_commit: await workspace.git("rev-parse", "HEAD"),
      pull_request_url: null,
    });
  });

  it.each([
    "closed",
    "closed-before-unavailable",
    "closed-with-foreign",
    "closed-after-create",
    "closed-after-lost-create",
    "no-changes",
    "foreign",
    "foreign-after-create",
    "revoked",
    "revoked-after-create",
    "unavailable-after-create",
    "malformed-after-create",
    "timeout-after-create",
  ] as const)(
    "preserves the original request outcome for %s observation after an earlier effect",
    async (outcome) => {
      const { owner, generation, client } = fixture;
      const foreign = outcome.startsWith("foreign");
      const revoked = outcome.startsWith("revoked");
      const afterCreate = outcome.endsWith("after-create");
      const unavailable = /^(unavailable|malformed|timeout)/u.test(outcome);
      const workspace = await createRealPublicationWorkspace(
        outcome === "closed-after-lost-create" ? "create" : "push",
      );
      const initial = (await rpc("sessions.github.publish", request()))[1];
      expect(initial.status).toBe("needs_confirmation");
      const pending = status(initial.requestId);
      const confirm = {
        sessionKey: SESSION_KEY,
        requestId: initial.requestId,
        generation,
        account,
        requestDigest: pending.confirmation!.requestDigest,
      };
      const headSha = await workspace.git("rev-parse", "HEAD");
      const marker = `<!-- openclaw-publication:${initial.requestId} -->`;
      const url = "https://github.com/openclaw/openclaw/pull/125203";
      const remote = mocks.runCommand.getMockImplementation()!;
      let created = false;
      let lookups = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (
          outcome === "no-changes" &&
          argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))
        ) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: headSha }));
        }
        if (argv.includes("POST")) {
          expect(JSON.parse(options?.input ?? "{}").body).toContain(marker);
          await remote(argv, options);
          created = true;
          return commandResult("", 1);
        }
        if (argv.includes("state=all")) {
          if (afterCreate && !created) {
            return commandResult("[]");
          }
          if (outcome === "unavailable-after-create") {
            return commandResult("", 1);
          }
          if (outcome === "malformed-after-create") {
            return commandResult("[{}");
          }
          if (outcome === "timeout-after-create") {
            throw new Error("synthetic remote timeout");
          }
          lookups += 1;
          if (outcome === "closed-before-unavailable" && lookups > 1) {
            throw new Error("synthetic later lookup unavailable");
          }
          if (revoked && lookups === 1) {
            client.connect.scopes = ["operator.read"];
          }
          return commandResult(
            JSON.stringify([
              {
                url,
                userId: foreign ? 202 : account.accountId,
                state: foreign ? "open" : "closed",
                body: marker,
                headSha,
                headRef: BRANCH,
                baseRef: "main",
              },
              ...(outcome === "closed-with-foreign"
                ? [
                    {
                      url: "https://github.com/openclaw/openclaw/pull/125204",
                      userId: 202,
                      state: "open",
                      body: "",
                      headSha,
                      headRef: BRANCH,
                      baseRef: "main",
                    },
                  ]
                : []),
            ]),
          );
        }
        return await remote(argv, options);
      });
      const confirmed = await rpc("sessions.github.confirm", confirm);
      expect(workspace.effects).toEqual(
        afterCreate || outcome === "closed-after-lost-create" ? ["push", "pull_request"] : ["push"],
      );
      if (unavailable) {
        expect(confirmed[0]).toBe(true);
        expect(confirmed[1]).toMatchObject({
          status: "needs_confirmation",
          requestId: initial.requestId,
          publisher: initial.publisher,
          effect: { kind: "pull_request", status: "dispatched", headCommit: headSha },
        });
        expect(status(initial.requestId).confirmation).toEqual(pending.confirmation);
        return;
      }
      if (revoked) {
        expect(confirmed[0]).toBe(false);
        expect(readPersonalGitHubPublication(owner, { requestId: initial.requestId })?.status).toBe(
          "needs_confirmation",
        );
        expect(
          readPersonalGitHubPublication(owner, { requestId: initial.requestId }),
        ).toMatchObject({
          last_effect: "pull_request",
          effect_state: "observed",
          pull_request_url: url,
        });
        return;
      }
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      const closed = outcome.startsWith("closed");
      expect(confirmed[1]).toMatchObject({
        requestId: initial.requestId,
        status: "failed",
        publisher: initial.publisher,
        code: outcome === "no-changes" ? "no_changes" : "github_rejected",
        effect: closed
          ? { kind: "pull_request", status: "observed", headCommit: headSha, url }
          : afterCreate
            ? { kind: "pull_request", status: "dispatched", headCommit: headSha }
            : initial.effect,
        nextAction: expect.stringContaining(
          closed ? "Reopen" : outcome === "no-changes" ? "change" : "permission",
        ),
      });
      expect(status(initial.requestId)).toEqual({ result: confirmed[1], confirmation: null });
      expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
      expect((await rpc("sessions.github.publish", request()))[1]).toEqual(confirmed[1]);
      expect((await rpc("sessions.github.confirm", confirm))[1]).toEqual(confirmed[1]);
      expect(workspace.effects).toEqual(
        afterCreate || outcome === "closed-after-lost-create" ? ["push", "pull_request"] : ["push"],
      );
      mocks.runCommand.mockImplementation(remote);
      const fresh = await rpc("sessions.github.publish", {
        ...request(),
        idempotencyKey: "fresh-reviewed-outcome",
      });
      expect(fresh[0], JSON.stringify(fresh[2])).toBe(true);
      expect(fresh[1].status).toBe("published");
      expect(fresh[1].requestId).not.toBe(initial.requestId);
    },
  );
});
