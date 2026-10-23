// Register the shared Git transport before any publication or run-lease consumer.
// oxfmt-ignore
import {
  BRANCH,
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  commands,
  createRealPublicationWorkspace,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
} from "./github-publication.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readPersonalGitHubPublicationInDatabase as readReceipt } from "./github-personal-publication-store.worker.js";
import {
  callPersonalPublicationRpc,
  createForeignPublicationSession,
  createPersonalPublicationFixture,
  readPersonalPublicationFixtureStatus,
  personalPublicationAccount as account,
  personalPublicationRequest,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";

const mocks = githubPublicationTestMocks();

describe("personal publication definitive outcomes", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => vi.unstubAllGlobals());
  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc(fixture, `sessions.github.${method}`, params);
  const request = () => personalPublicationRequest(fixture, "personal-publish");
  const status = (requestId: string) => readPersonalPublicationFixtureStatus(fixture, requestId);
  const read = (requestId?: string) =>
    readReceipt(
      openOpenClawStateDatabase().db,
      fixture.owner,
      requestId
        ? { requestId }
        : { sessionId: SESSION_ID, idempotencyKey: request().idempotencyKey },
    );
  const pull = (
    headSha: string,
    overrides: { url?: string; userId?: number; state?: string; body?: string } = {},
  ) => ({
    url: "https://github.com/openclaw/openclaw/pull/125200",
    userId: account.accountId,
    state: "open",
    body: "",
    headSha,
    headRef: BRANCH,
    baseRef: "main",
    ...overrides,
  });
  it.each([
    ["connection closes", false],
    ["permission ends during readback", true],
  ] as const)(
    "retains an accepted open PR response after the requesting %s",
    async (_boundary, readback) => {
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
            JSON.stringify([pull(await workspace.git("rev-parse", "HEAD"))]),
          );
        }
        if (creating || (readback && created && argv.includes("state=all"))) {
          if (readback) {
            fixture.client.connect.scopes = ["operator.read"];
          } else {
            fixture.runtime.live = false;
          }
        }
        return response;
      });

      const published = await fixture.coordinator.requestPersonalForSessionV2(
        request(),
        fixture.action,
      );

      expect(published).toMatchObject({
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/125200",
      });
      expect(read(published.requestId)).toMatchObject({
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
    const response = await rpc("publish", {
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
    "no-changes",
    "foreign-after-create",
    "revoked-after-create",
    "unavailable-after-create",
    "malformed-after-create",
  ] as const)(
    "preserves the original request outcome for %s observation after an earlier effect",
    async (outcome) => {
      const { generation, client } = fixture;
      const foreign = outcome.startsWith("foreign");
      const revoked = outcome.startsWith("revoked");
      const afterCreate = outcome.endsWith("after-create");
      const unavailable = /^(unavailable|malformed)/u.test(outcome);
      const workspace = await createRealPublicationWorkspace("push");
      const initial = (await rpc("publish", request()))[1];
      expect(initial.status).toBe("needs_confirmation");
      const pending = await status(initial.requestId);
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
      const dispatched = { kind: "pull_request", status: "dispatched", headCommit: headSha };
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
          lookups += 1;
          if (revoked && lookups === 1) {
            client.connect.scopes = ["operator.read"];
          }
          return commandResult(
            JSON.stringify([
              pull(headSha, {
                url,
                userId: foreign ? 202 : account.accountId,
                state: foreign ? "open" : "closed",
                body: marker,
              }),
            ]),
          );
        }
        return await remote(argv, options);
      });
      const confirmed = await rpc("confirm", confirm);
      expect(workspace.effects).toEqual(afterCreate ? ["push", "pull_request"] : ["push"]);
      if (unavailable) {
        expect(confirmed[0]).toBe(true);
        expect(confirmed[1]).toMatchObject({
          status: "needs_confirmation",
          requestId: initial.requestId,
          publisher: initial.publisher,
          effect: dispatched,
        });
        expect((await status(initial.requestId)).confirmation).toEqual(pending.confirmation);
        return;
      }
      if (revoked) {
        expect(confirmed[0]).toBe(false);
        expect(read(initial.requestId)).toMatchObject({
          status: "needs_confirmation",
          last_effect: "pull_request",
          effect_state: "observed",
          pull_request_url: url,
        });
        return;
      }
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      expect(confirmed[1]).toMatchObject({
        requestId: initial.requestId,
        status: "failed",
        publisher: initial.publisher,
        code: outcome === "no-changes" ? "no_changes" : "github_rejected",
        effect: afterCreate ? dispatched : initial.effect,
        nextAction: expect.stringContaining(outcome === "no-changes" ? "change" : "permission"),
      });
      expect(await status(initial.requestId)).toEqual({ result: confirmed[1], confirmation: null });
      expect((await rpc("options"))[1].pendingPersonal).toBeNull();
      expect((await rpc("publish", request()))[1]).toEqual(confirmed[1]);
      expect((await rpc("confirm", confirm))[1]).toEqual(confirmed[1]);
      expect(workspace.effects).toEqual(afterCreate ? ["push", "pull_request"] : ["push"]);
      mocks.runCommand.mockImplementation(remote);
      const fresh = await rpc("publish", {
        ...request(),
        idempotencyKey: "fresh-reviewed-outcome",
      });
      expect(fresh[0], JSON.stringify(fresh[2])).toBe(true);
      expect(fresh[1].status, JSON.stringify(fresh[1])).toBe("published");
      expect(fresh[1].requestId).not.toBe(initial.requestId);
    },
  );

  it("stops offering a pending confirmation once the session is archived", async () => {
    const { client, context, coordinator, generation } = fixture;
    await persistPublicationTestSession();
    const prepared = await preparePersonalPublicationFixtureAction({ client, context });
    const interruption = new Error("Publication claim preparation interrupted.");
    let preparedSources = 0;
    // Interrupt claim preparation after the request commits, preserving its receipt.
    const stopped = {
      ...prepared,
      prepareSource: (selector: Parameters<typeof prepared.prepareSource>[0]) => {
        if (++preparedSources === 2) {
          throw interruption;
        }
        return prepared.prepareSource(selector);
      },
    };
    await expect(coordinator.requestPersonalForSessionV2(request(), stopped)).rejects.toBe(
      interruption,
    );
    const row = read();
    expect(row).toMatchObject({ status: "requested", execution_id: null });
    const requestId = row!.request_id;
    const pending = await rpc("status", { sessionKey: SESSION_KEY, requestId });
    expect(pending[1]).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation, account },
    });
    // Archiving preserves sessionId/lifecycleRevision; archivedAt must retire confirmation.
    await patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY }, () => ({
      archivedAt: Date.now(),
    }));
    const stoppedSession = {
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    };
    expect((await rpc("status", { sessionKey: SESSION_KEY, requestId }))[1]).toMatchObject(
      stoppedSession,
    );
    expect((await rpc("options"))[1].pendingPersonal).toMatchObject(stoppedSession);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });
});
