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
import { readPersonalGitHubPublicationInDatabase } from "./github-personal-publication-store.worker.js";
import {
  callPersonalPublicationRpc,
  createForeignPublicationSession,
  createPersonalPublicationFixture,
  readPersonalPublicationFixtureStatus,
  personalPublicationAccount as account,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";
import {
  claimGitHubPublicationExecutionInDatabase,
  createGitHubPublicationExecutionStoreInDatabase,
  readGitHubPublicationRequest,
} from "./github-publication-store.worker.js";
import { insertSharedWorktreeReceipt } from "./github-shared-publication.test-support.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";

const mocks = githubPublicationTestMocks();
const table = "github_personal_publication_requests";

describe("personal publication definitive outcomes", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const rpc = (
    method: string,
    params?: Record<string, unknown>,
    hooks?: Parameters<typeof callPersonalPublicationRpc>[3],
  ) => callPersonalPublicationRpc(fixture, method, params, hooks);
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation: fixture.generation, account },
  });
  const status = (requestId: string) => readPersonalPublicationFixtureStatus(fixture, requestId);
  it.each([
    { boundary: "connection closes", readback: false },
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

      const published = await fixture.coordinator.requestPersonalForSessionV2(
        request(),
        fixture.action,
      );

      expect(published).toMatchObject({
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/125200",
      });
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, fixture.owner, {
          requestId: published.requestId,
        }),
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
    "no-changes",
    "foreign-after-create",
    "revoked-after-create",
    "unavailable-after-create",
    "malformed-after-create",
  ] as const)(
    "preserves the original request outcome for %s observation after an earlier effect",
    async (outcome) => {
      const { owner, generation, client } = fixture;
      const foreign = outcome.startsWith("foreign");
      const revoked = outcome.startsWith("revoked");
      const afterCreate = outcome.endsWith("after-create");
      const unavailable = /^(unavailable|malformed)/u.test(outcome);
      const workspace = await createRealPublicationWorkspace("push");
      const initial = (await rpc("sessions.github.publish", request()))[1];
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
              {
                url,
                userId: foreign ? 202 : account.accountId,
                state: foreign ? "open" : "closed",
                body: marker,
                headSha,
                headRef: BRANCH,
                baseRef: "main",
              },
            ]),
          );
        }
        return await remote(argv, options);
      });
      const confirmed = await rpc("sessions.github.confirm", confirm);
      expect(workspace.effects).toEqual(afterCreate ? ["push", "pull_request"] : ["push"]);
      if (unavailable) {
        expect(confirmed[0]).toBe(true);
        expect(confirmed[1]).toMatchObject({
          status: "needs_confirmation",
          requestId: initial.requestId,
          publisher: initial.publisher,
          effect: { kind: "pull_request", status: "dispatched", headCommit: headSha },
        });
        expect((await status(initial.requestId)).confirmation).toEqual(pending.confirmation);
        return;
      }
      if (revoked) {
        expect(confirmed[0]).toBe(false);
        expect(
          readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
            requestId: initial.requestId,
          })?.status,
        ).toBe("needs_confirmation");
        expect(
          readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
            requestId: initial.requestId,
          }),
        ).toMatchObject({
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
        effect: afterCreate
          ? { kind: "pull_request", status: "dispatched", headCommit: headSha }
          : initial.effect,
        nextAction: expect.stringContaining(outcome === "no-changes" ? "change" : "permission"),
      });
      expect(await status(initial.requestId)).toEqual({ result: confirmed[1], confirmation: null });
      expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
      expect((await rpc("sessions.github.publish", request()))[1]).toEqual(confirmed[1]);
      expect((await rpc("sessions.github.confirm", confirm))[1]).toEqual(confirmed[1]);
      expect(workspace.effects).toEqual(afterCreate ? ["push", "pull_request"] : ["push"]);
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

  // Interrupt claim preparation after the request commits, preserving a recoverable receipt.
  const createStoppedPersonalRequest = async () => {
    const { client, context, coordinator } = fixture;
    const persisted = await persistPublicationTestSession();
    const prepared = await preparePersonalPublicationFixtureAction({ client, context });
    const interruption = new Error("Publication claim preparation interrupted.");
    let preparedSources = 0;
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
    const row = openOpenClawStateDatabase()
      .db.prepare(`SELECT request_id, status, execution_id FROM ${table}`)
      .get() as { request_id: string; status: string; execution_id: null };
    expect(row).toMatchObject({ status: "requested", execution_id: null });
    return { requestId: row.request_id, session: persisted.read() };
  };
  // The scope omits storePath: the fixture persists through the resolved agent store, and
  // a custom locator would resolve a different SQLite file and silently no-op the patch.
  const archiveSession = () =>
    patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY }, () => ({
      archivedAt: Date.now(),
    }));
  const restoreSession = () =>
    patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY }, () => ({
      archivedAt: undefined,
    }));

  it("stops offering a pending confirmation once the session is archived", async () => {
    const { generation } = fixture;
    const { requestId } = await createStoppedPersonalRequest();
    const pending = await rpc("sessions.github.status", {
      sessionKey: SESSION_KEY,
      requestId,
    });
    expect(pending[1]).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation, account },
    });
    // Archiving preserves sessionId/lifecycleRevision, so only an explicit archivedAt
    // check can retire the pending confirmation the archived confirm action would reject.
    await archiveSession();
    const discovered = await rpc("sessions.github.status", {
      sessionKey: SESSION_KEY,
      requestId,
    });
    expect(discovered[1]).toMatchObject({
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    });
    expect((await rpc("sessions.github.options"))[1].pendingPersonal).toMatchObject({
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("projects an archive that lands while publication options are awaited", async () => {
    await createStoppedPersonalRequest();
    const before = await rpc("sessions.github.options");
    expect(before[1].pendingPersonal).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
    // The archive lands inside the awaited personal-status work, after the options
    // request captured its request-start session snapshot; the projection must re-read
    // archivedAt instead of offering the confirmation the archived session would reject.
    const discovered = await rpc(
      "sessions.github.options",
      { sessionKey: SESSION_KEY },
      { duringPersonalStatus: archiveSession },
    );
    expect(discovered[1].pendingPersonal).toMatchObject({
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("revives the pending confirmation when a restore lands while options are awaited", async () => {
    await createStoppedPersonalRequest();
    await archiveSession();
    // The restore lands inside the awaited personal-status work; the projection must use
    // the refreshed archivedAt instead of reporting session_changed for an active session.
    const revived = await rpc(
      "sessions.github.options",
      { sessionKey: SESSION_KEY },
      { duringPersonalStatus: restoreSession },
    );
    expect(revived[0], JSON.stringify(revived[2])).toBe(true);
    expect(revived[1].pendingPersonal).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
  });

  it("pins the response archive snapshot through shared receipt supersession", async () => {
    const { requestId, session } = await createStoppedPersonalRequest();
    const shared = insertSharedWorktreeReceipt("archive-supersession", {
      session: {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        lifecycleRevision: session.lifecycleRevision ?? null,
      },
      createdAtMs: Date.now(),
    });
    const instance = "archive-supersession-instance";
    const database = openOpenClawStateDatabase();
    createGitHubPublicationExecutionStoreInDatabase(database, instance).complete(
      claimGitHubPublicationExecutionInDatabase(database, shared.request_id, instance),
      {
        requestId: shared.request_id,
        status: "failed",
        code: "unavailable",
        message: "Synthetic publication failure.",
        nextAction: "Review the recorded request.",
      },
    );
    const readShared = () =>
      readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
        requestId: shared.request_id,
      });
    const originalShared = readShared();
    const originalPersonal = readPersonalGitHubPublicationInDatabase(
      openOpenClawStateDatabase().db,
      fixture.owner,
      { requestId },
    );
    fixture.context.controlUiSessionPullRequests = {
      readPrepared: vi.fn(),
      read: vi.fn(async () => {
        throw new Error("No session PR projection is installed in this fixture.");
      }),
      replace: vi.fn(async () => {}),
      unsubscribe: vi.fn(),
      pollNow: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const latestShared = fixture.coordinator.latestShared.bind(fixture.coordinator);
    const supersessionEntered = vi.fn();
    let changeArchive: (() => Promise<unknown>) | undefined;
    let restoreBeforeSharedRead = false;
    const coordinator: typeof fixture.coordinator = {
      ...fixture.coordinator,
      latestShared: async (current, idempotencyKey, isSuperseded) => {
        // Archived sessions have no shared discovery result, so restore before
        // that read, after pendingPersonal captured the archived snapshot.
        if (restoreBeforeSharedRead) {
          await restoreSession();
        }
        return latestShared(current, idempotencyKey, async (snapshot) => {
          supersessionEntered();
          await changeArchive?.();
          // Exercise the real callback: refreshing its read must not replace the
          // earlier snapshot used to compute pendingPersonal.
          if (!isSuperseded) {
            throw new Error("Expected the session supersession callback.");
          }
          return isSuperseded(snapshot);
        });
      },
    };
    const options = () =>
      callPersonalPublicationRpc({ ...fixture, coordinator }, "sessions.github.options");
    const unchanged = await options();
    expect(supersessionEntered).toHaveBeenCalledTimes(1);
    expect(unchanged[0], JSON.stringify(unchanged[2])).toBe(true);
    expect(unchanged[1]).toMatchObject({
      pendingPersonal: {
        result: { status: "needs_confirmation" },
        confirmation: { generation: fixture.generation, account },
      },
      latestShared: { result: { requestId: shared.request_id, status: "failed" } },
    });

    changeArchive = archiveSession;
    const archived = await options();
    expect(supersessionEntered).toHaveBeenCalledTimes(2);
    expect(archived[0]).toBe(false);
    expect(JSON.stringify(archived[2])).toContain("session access changed");
    changeArchive = undefined;
    const freshArchived = await options();
    expect(freshArchived[0], JSON.stringify(freshArchived[2])).toBe(true);
    expect(freshArchived[1].pendingPersonal).toMatchObject({
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    });

    expect(supersessionEntered).toHaveBeenCalledTimes(2);
    restoreBeforeSharedRead = true;
    const restored = await options();
    expect(supersessionEntered).toHaveBeenCalledTimes(3);
    expect(restored[0]).toBe(false);
    expect(JSON.stringify(restored[2])).toContain("session access changed");
    restoreBeforeSharedRead = false;
    const freshRestored = await options();
    expect(supersessionEntered).toHaveBeenCalledTimes(4);
    expect(freshRestored[0], JSON.stringify(freshRestored[2])).toBe(true);
    expect(freshRestored[1].pendingPersonal).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
    expect(readShared()).toEqual(originalShared);
    expect(
      readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, fixture.owner, {
        requestId,
      }),
    ).toEqual(originalPersonal);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });
});
