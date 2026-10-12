import { afterEach, describe, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../state/github-personal-publication-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount,
  expectPersonalPublicationReplay,
} from "./github-personal-publication.test-support.js";
import { claimRepositoryGitHubPublicationAsync } from "./github-publication-store-async.js";
import {
  SESSION_ID,
  SESSION_KEY,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { listRepositoryGitHubPublicationsInDatabase } from "./github-repository-publication-read.worker.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import {
  createRepositoryPublicationFixture,
  repositoryPublicationTestUrl as url,
} from "./github-repository-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const readRepositoryGitHubPublication = (requestId: string) =>
  readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);
const listRepositoryGitHubPublications = (
  filter: Parameters<typeof listRepositoryGitHubPublicationsInDatabase>[1] = {},
) => listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, filter);

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
function repositoryFixture(
  requestedRef?: Parameters<typeof createRepositoryPublicationFixture>[1],
  session?: Parameters<typeof createRepositoryPublicationFixture>[2],
) {
  return createRepositoryPublicationFixture(checkpoint, requestedRef, session);
}

function seedPublicationWorker(
  placements: Parameters<typeof seedActivePlacement>[0],
  environmentId: string,
  executionMode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  const owner = { environmentId, ownerEpoch: 7 };
  seedAttachedPlacementEnvironment(openOpenClawStateDatabase(), {
    ...owner,
    sessionId: REQUEST.sessionId,
  });
  return seedActivePlacement(placements, { ...owner, executionMode });
}

describe("repository checkpoint GitHub publication", () => {
  installGitHubPublicationTestHarness();
  afterEach(() => vi.unstubAllGlobals());

  it.each(["shared", "personal"] as const)(
    "retains the accepted %s PR response after publication authority closes",
    async (source) => {
      const f = await repositoryFixture();
      const person = source === "personal" ? await createPersonalPublicationFixture() : undefined;
      if (person) {
        f.runtime.accountId = personalPublicationAccount.accountId;
      }
      let current = true;
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args: string[], options) => {
        const result = await transport(args, options);
        if (args.includes("repos/owner/repository/pulls") && args.includes("POST")) {
          current = false;
          if (person) {
            person.runtime.live = false;
          }
        }
        return result;
      });
      const coordinator = person?.coordinator ?? f.coordinator;
      const request = () =>
        person
          ? coordinator.requestPersonalForSessionV2(
              {
                sessionKey: SESSION_KEY,
                idempotencyKey: "accepted-before-close",
                selection: {
                  source: "personal",
                  generation: person.generation,
                  account: personalPublicationAccount,
                },
              },
              person.action,
            )
          : coordinator.requestForSessionV2({
              agentId: "main",
              sessionKey: SESSION_KEY,
              idempotencyKey: "accepted-before-close",
              assertCurrent: () => {
                if (!current) {
                  throw new Error("Publication authority closed");
                }
              },
            });
      const published = await request();
      expect(published).toMatchObject({ status: "published", url });
      expect(readRepositoryGitHubPublication(published.requestId)).toMatchObject({
        status: "published",
        pull_request_url: url,
        last_effect: "pull_request",
        effect_state: "observed",
        pushed_head_commit: f.runtime.head,
      });
      const commandCount = mocks.runCommand.mock.calls.length;
      await coordinator.resumeSessionRequests();
      current = true;
      if (person) {
        person.runtime.live = true;
      }
      expect(await request()).toEqual(published);
      expect(mocks.runCommand.mock.calls).toHaveLength(commandCount);
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    },
  );

  it("replays only the original personal selection and content without new repository publication work", async () => {
    const f = await repositoryFixture();
    const person = await createPersonalPublicationFixture();
    f.runtime.accountId = personalPublicationAccount.accountId;
    await expectPersonalPublicationReplay(person, (requestId) => ({
      receipt: readRepositoryGitHubPublication(requestId),
      commandCount: mocks.runCommand.mock.calls.length,
      effects: [...f.runtime.effects],
    }));
  });

  it.each(["shared", "personal"] as const)(
    "records unavailable %s publication without losing its accepted recovery checkpoint",
    async (source) => {
      const f = await repositoryFixture();
      const retained = await getSessionRepositoryWorkspaceStore().get(f.workspace.workspaceId);
      checkpoint.mockImplementation(async (_request, use) => await use({}));
      const personal = source === "personal" ? await createPersonalPublicationFixture() : undefined;
      if (personal) {
        f.runtime.accountId = personalPublicationAccount.accountId;
      }
      const coordinator = personal?.coordinator ?? f.coordinator;
      const request = () =>
        personal
          ? coordinator.requestPersonalForSessionV2(
              {
                sessionKey: SESSION_KEY,
                idempotencyKey: "no-publication-snapshot",
                selection: {
                  source: "personal",
                  generation: personal.generation,
                  account: personalPublicationAccount,
                },
              },
              personal.action,
            )
          : coordinator.requestForSessionV2({
              agentId: "main",
              sessionKey: SESSION_KEY,
              idempotencyKey: "no-publication-snapshot",
            });
      const result = await request();
      expect(result).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining("Git clean filters"),
      });
      expect(readRepositoryGitHubPublication(result.requestId)).toMatchObject({
        status: "failed",
        error_code: "unavailable",
        checkpoint_ref: null,
        last_effect: null,
        owner_profile_id: personal?.owner ?? null,
      });
      expect(await getSessionRepositoryWorkspaceStore().get(f.workspace.workspaceId)).toEqual(
        retained,
      );
      expect(await request()).toEqual(result);
      await coordinator.resumeSessionRequests();
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(await coordinator.listUnreportedResultsAsync()).toEqual([
        expect.objectContaining({
          result: expect.objectContaining({
            requestId: result.requestId,
            status: "failed",
            code: "unavailable",
          }),
        }),
      ]);
      expect(f.runtime.effects).toEqual([]);
    },
  );

  it("cannot record publication unavailability after its accepted checkpoint changes", async () => {
    const f = await repositoryFixture();
    checkpoint.mockImplementationOnce(async (_request, use) => {
      await f.capture("new accepted edit\n", "replacement-checkpoint");
      return await use({});
    });
    await expect(
      f.coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "changed-unavailable",
      }),
    ).rejects.toThrow("checkpoint changed");
    expect(listRepositoryGitHubPublications()).toEqual([
      expect.objectContaining({ status: "requested", error_code: null, last_effect: null }),
    ]);
    expect(f.runtime.effects).toEqual([]);
  });

  it.each([
    { name: "topic", ref: "topic" },
    { name: "tag", ref: "refs/tags/release" },
    { name: "commit", ref: { kind: "commit" } },
  ] as const)(
    "publishes unchanged pinned $name when its merge-base has a different tree",
    async ({ ref }) => {
      const f = await repositoryFixture(ref);
      await f.capture(null, "unchanged-pinned-source");
      f.runtime.baseHead = "d".repeat(40);
      f.runtime.baseHeadTree = "c".repeat(40);
      f.runtime.mergeBase = "e".repeat(40);
      f.runtime.mergeBaseTree = "c".repeat(40);
      const result = await f.coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "related-ref",
      });
      expect(result.status).toBe("published");
      expect(f.runtime.pr?.baseRef).toBe(ref === "topic" ? "topic" : "main");
      expect(f.runtime.uploaded.size).toBe(0);
      expect(readRepositoryGitHubPublication(result.requestId)?.workspace_tree).toBe(f.baseTree);
      expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40), force: false });
    },
  );

  it("rejects a missing common ancestor before uploading or changing references", async () => {
    const f = await repositoryFixture();
    f.runtime.commonHistory = false;
    const result = await f.coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "unrelated-ref",
    });
    expect(result.status).toBe("failed");
    expect(f.runtime.uploaded.size).toBe(0);
    expect(f.runtime.effects).toEqual([]);
  });

  it("distinguishes an unchanged published tree from a complete revert to the PR base", async () => {
    const f = await repositoryFixture();
    const publish = (idempotencyKey: string) =>
      f.coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey,
      });
    const first = await publish("before-revert");
    expect(first.status).toBe("published");
    const previousHead = f.runtime.head;
    expect(await publish("unchanged-prior-head")).toMatchObject({
      status: "failed",
      code: "no_changes",
    });
    expect(f.casRequests).toHaveLength(1);
    expect(f.runtime.head).toBe(previousHead);
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    await f.capture(null, "complete-revert");
    const reverted = await publish("complete-revert");
    expect(reverted).toMatchObject({ status: "published", url });
    expect(readRepositoryGitHubPublication(reverted.requestId)).toMatchObject({
      workspace_tree: f.baseTree,
      previous_head_commit: previousHead,
      source_head_commit: f.baseCommit,
    });
    expect(f.runtime.head).not.toBe(previousHead);
    expect(f.casRequests[1]).toMatchObject({
      beforeOid: previousHead,
      afterOid: f.runtime.head,
      force: false,
    });
    expect(f.runtime.effects).toEqual(["push", "pull_request", "push"]);
    f.runtime.head = "f".repeat(40);
    const commandsBefore = mocks.runCommand.mock.calls.length;
    expect(await publish("foreign-head-after-revert")).toMatchObject({
      status: "failed",
      code: "push_rejected",
      nextAction: expect.stringContaining("published head"),
    });
    expect(f.casRequests).toHaveLength(2);
    expect(
      mocks.runCommand.mock.calls.slice(commandsBefore).some(([args]) => args.includes("POST")),
    ).toBe(false);
  });

  it("does not recreate a deleted branch when a prior published head was recorded", async () => {
    const f = await repositoryFixture();
    await f.coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "before-delete",
    });
    f.runtime.head = null;
    await f.capture("next accepted change\n", "after-delete");
    const result = await f.coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "after-delete",
    });
    expect(result).toMatchObject({ status: "failed", code: "push_rejected" });
    expect(f.runtime.head).toBeNull();
    expect(f.casRequests).toHaveLength(1);
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
  });

  it("extends its recorded pushed head after the earlier PR was closed before confirmation", async () => {
    const f = await repositoryFixture();
    f.runtime.closePullRequest = true;
    const failed = await f.coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "closed-before-confirmation",
    });
    expect(failed).toMatchObject({ status: "failed", code: "github_rejected" });
    const pushedHead = f.runtime.head;
    expect(pushedHead).not.toBeNull();
    expect(readRepositoryGitHubPublication(failed.requestId)).toMatchObject({
      pushed_head_commit: pushedHead,
      last_effect: "pull_request",
      effect_state: "observed",
    });
    f.runtime.closePullRequest = false;
    await f.capture("accepted after closed PR\n", "after-closed-pr");
    const published = await f.coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "fresh-after-closed-pr",
    });
    expect(published.status).toBe("published");
    expect(f.casRequests[1]).toMatchObject({ beforeOid: pushedHead, force: false });
    expect(f.runtime.effects).toEqual(["push", "pull_request", "push", "pull_request"]);
  });

  it("records a recovered push response even when authority closes during its observation", async () => {
    const f = await repositoryFixture();
    f.runtime.interruptPush = true;
    let current = true;
    const request = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "lost-push-response",
      assertCurrent: () => {
        if (!current) {
          throw new Error("Publication authority closed");
        }
      },
    };
    const first = await f.coordinator.requestForSessionV2(request);
    expect(first.status).toBe("requested");
    expect(readRepositoryGitHubPublication(first.requestId)?.pushed_head_commit).toBeNull();
    f.runtime.afterHeadObservation = () => {
      current = false;
    };
    expect((await f.coordinator.requestForSessionV2(request)).status).toBe("requested");
    expect(readRepositoryGitHubPublication(first.requestId)?.pushed_head_commit).toBe(
      f.runtime.head,
    );
    expect(f.runtime.effects).toEqual(["push"]);
  });

  it.each([
    { source: "shared", boundary: "reset" },
    { source: "personal", boundary: "reset" },
    { source: "shared", boundary: "move" },
    { source: "personal", boundary: "move" },
  ] as const)(
    "records an in-flight $source push after $boundary before retiring publication authority",
    async ({ source, boundary }) => {
      const f = await repositoryFixture();
      const person = source === "personal" ? await createPersonalPublicationFixture() : undefined;
      if (person) {
        f.runtime.accountId = personalPublicationAccount.accountId;
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args: string[], options) => {
        const result = await transport(args, options);
        if (args.includes("graphql")) {
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      const pending = person
        ? person.coordinator.requestPersonalForSessionV2(
            {
              sessionKey: SESSION_KEY,
              idempotencyKey: "reset-during-push",
              selection: {
                source: "personal",
                generation: person.generation,
                account: personalPublicationAccount,
              },
            },
            person.action,
          )
        : f.coordinator.requestForSessionV2({
            agentId: "main",
            sessionKey: SESSION_KEY,
            idempotencyKey: "reset-during-push",
          });
      try {
        await entered.promise;
        await expect(
          f.placements.withWorkspaceExclusion(SESSION_ID, async () => {}),
        ).rejects.toThrow();
        if (boundary === "reset") {
          await f.closeSession("reset");
        } else {
          await patchSessionEntryCore(
            {
              agentId: "main",
              sessionKey: SESSION_KEY,
              storePath: mocks.loadSession(SESSION_KEY).storePath,
            },
            (current) => ({
              ...current,
              repositoryWorkspaceId: undefined,
            }),
            { replaceEntry: true },
          );
          expect(mocks.loadSession(SESSION_KEY).entry.repositoryWorkspaceId).toBeUndefined();
        }
        const recovering = createTestGitHubPublicationCoordinator({ placements: f.placements });
        await recovering.resumeSessionRequests();
        expect(listRepositoryGitHubPublications()[0]).toMatchObject({
          status: "publishing",
          last_effect: "push",
          effect_state: "dispatched",
        });
      } finally {
        release.resolve();
      }
      expect(await pending).toMatchObject({ status: "failed", code: "session_changed" });
      expect(listRepositoryGitHubPublications()[0]).toMatchObject({
        status: "failed",
        error_code: "session_changed",
        last_effect: "push",
        effect_state: "observed",
        pushed_head_commit: f.runtime.head,
      });
      expect(f.runtime.effects).toEqual(["push"]);
      if (boundary === "move") {
        if (person) {
          const requestId = listRepositoryGitHubPublications()[0]!.request_id;
          const prepared = await person.coordinator.preparePersonalStatus(requestId);
          expect(
            await person.coordinator.personalStatusAsync(
              person.action,
              person.action,
              requestId,
              prepared,
            ),
          ).toMatchObject({
            result: { status: "failed", code: "session_changed" },
            confirmation: null,
          });
        }
        return;
      }
      await f.capture("new session edit\n", "after-reset");
      const next = await f.coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "new-after-reset",
      });
      expect(next.status).toBe("published");
      expect(
        listRepositoryGitHubPublications().find((row) => row.request_id === next.requestId)
          ?.previous_head_commit,
      ).toBe(f.casRequests[0]!.afterOid);
    },
  );

  it.each(["archive", "reset"] as const)(
    "retires a pending receipt after %s and continues a later session's publication",
    async (kind) => {
      const stale = await repositoryFixture();
      stale.runtime.interruptPush = true;
      const first = await stale.coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "stale-before-recovery",
      });
      expect(first.status).toBe("requested");
      const retained = await claimRepositoryGitHubPublicationAsync(
        readRepositoryGitHubPublication(first.requestId)!,
        "retained-execution",
        {
          assertCustody: () => {},
          assertAction: () => {},
          prepareSource: async () => {
            throw new Error("Unexpected source acquisition");
          },
        },
      );
      await stale.closeSession(kind);
      if (kind === "reset") {
        await expect(
          stale.coordinator.requestForSessionV2({
            agentId: "main",
            sessionKey: SESSION_KEY,
            idempotencyKey: "stale-before-recovery",
          }),
        ).rejects.toThrow("session lifecycle changed");
      }
      await stale.coordinator.resumeSessionRequests();
      expect(readRepositoryGitHubPublication(first.requestId)).toMatchObject({
        status: "failed",
        error_code: "session_changed",
        execution_id: null,
      });
      await expect(
        retained.recordEffect("push", { headCommit: stale.runtime.head! }),
      ).rejects.toThrow();
      expect(stale.runtime.effects).toEqual(["push"]);
      const validSession = {
        sessionId: "valid-later-session",
        sessionKey: "agent:main:valid-later",
      };
      const valid = await repositoryFixture(undefined, validSession);
      valid.runtime.interruptPush = true;
      const second = await valid.coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: validSession.sessionKey,
        idempotencyKey: "valid-after-stale",
      });
      expect(second.status).toBe("requested");
      await valid.coordinator.resumeSessionRequests();
      expect(readRepositoryGitHubPublication(second.requestId)?.status).toBe("published");
      expect(valid.runtime.effects).toEqual(["push", "pull_request"]);
    },
  );

  it.each(["pending result", "reservation", "identity mismatch"] as const)(
    "continues later publications when the first session has a %s and reports hard failures",
    async (blocker) => {
      const blocked = await repositoryFixture(undefined, REQUEST);
      blocked.runtime.interruptPush = true;
      const first = await blocked.coordinator.requestForSessionV2({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        idempotencyKey: "blocked-first",
      });
      expect(first.status).toBe("requested");
      const released = createDeferredCore();
      let held: Promise<void> | undefined;
      try {
        if (blocker === "pending result") {
          await seedPublicationWorker(
            blocked.placements,
            "pending-publication-worker",
            "remote-exec",
          );
          const pendingClaim = await blocked.placements.claimTurn({
            sessionId: REQUEST.sessionId,
            sessionKey: REQUEST.sessionKey,
            agentId: REQUEST.agentId,
            claimId: "pending-result-claim",
            runId: "pending-result-run",
            owner: { kind: "local", environmentId: "pending-publication-worker", ownerEpoch: 7 },
          });
          await blocked.placements.markWorkspaceResultPending(pendingClaim);
          expect(blocked.placements.clearLocalTurnClaimsAfterRestart()).toBe(1);
          expect(blocked.placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
          expect(await blocked.placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        } else if (blocker === "reservation") {
          const entered = createDeferredCore();
          held = blocked.placements.withWorkspaceExclusion(REQUEST.sessionId, async () => {
            entered.resolve();
            await released.promise;
          });
          void held.catch(entered.reject);
          await entered.promise;
        } else {
          await blocked.placements.startDispatch({ ...REQUEST, agentId: "different-agent" });
        }
        const validSession = {
          sessionId: "valid-after-blocked",
          sessionKey: "agent:main:valid-after-blocked",
        };
        const valid = await repositoryFixture(undefined, validSession);
        valid.runtime.interruptPush = true;
        const second = await valid.coordinator.requestForSessionV2({
          agentId: "main",
          sessionKey: validSession.sessionKey,
          idempotencyKey: "valid-after-blocked",
        });
        expect(second.status).toBe("requested");
        expect(
          listRepositoryGitHubPublications({ pending: true }).map((row) => row.request_id),
        ).toEqual([first.requestId, second.requestId]);
        const recovery = valid.coordinator.resumeSessionRequests();
        if (blocker === "identity mismatch") {
          await expect(recovery).rejects.toThrow("placement identity changed");
        } else {
          await recovery;
        }
        expect(readRepositoryGitHubPublication(first.requestId)?.status).toBe("requested");
        expect(readRepositoryGitHubPublication(second.requestId)?.status).toBe("published");
        expect(blocked.runtime.effects).toEqual(["push"]);
        expect(valid.runtime.effects).toEqual(["push", "pull_request"]);
      } finally {
        released.resolve();
        await held;
      }
    },
  );

  it.each([
    { executionMode: "worker-turn", publication: "available" },
    { executionMode: "remote-exec", publication: "available" },
    { executionMode: "worker-turn", publication: "unavailable" },
    { executionMode: "remote-exec", publication: "unavailable" },
  ] as const)(
    "settles the accepted checkpoint for an in-turn $executionMode request with publication $publication",
    async ({ executionMode, publication }) => {
      const f = await repositoryFixture(undefined, REQUEST);
      await seedPublicationWorker(f.placements, "in-turn-worker", executionMode);
      const claim = await f.placements.claimTurn({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        claimId: "in-turn-publication",
        runId: "in-turn-run",
        owner: {
          kind: executionMode === "remote-exec" ? "local" : "worker",
          environmentId: "in-turn-worker",
          ownerEpoch: 7,
        },
      });
      const requested = await f.coordinator.requestForSessionV2({
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        expectedRunId: claim.runId,
        idempotencyKey: "in-turn-" + executionMode,
      });
      expect(requested.status).toBe("requested");
      expect(readRepositoryGitHubPublication(requested.requestId)).toMatchObject({
        claim_id: claim.claimId,
        run_id: claim.runId,
        environment_id: "in-turn-worker",
        owner_epoch: 7,
        placement_generation: claim.placementGeneration,
        checkpoint_ref: null,
      });
      expect(f.runtime.effects).toEqual([]);
      const accepted = await f.capture("completed turn change\n", "in-turn-completed");
      if (publication === "unavailable") {
        checkpoint.mockImplementation(async (_request, use) => await use({}));
      }
      await f.placements.markWorkspaceResultPending(claim);
      await f.coordinator.prepareClaimWorkspace(claim);
      await f.placements.acceptWorkspaceResult(claim);
      if (publication === "unavailable") {
        expect(await f.coordinator.processClaim(claim)).toEqual([]);
        expect(readRepositoryGitHubPublication(requested.requestId)).toMatchObject({
          status: "failed",
          error_code: "unavailable",
          last_effect: null,
        });
        expect(await f.coordinator.listUnreportedResultsAsync()).toEqual([
          expect.objectContaining({
            result: expect.objectContaining({
              requestId: requested.requestId,
              status: "failed",
              code: "unavailable",
            }),
          }),
        ]);
        expect(f.runtime.effects).toEqual([]);
        return;
      }
      expect(await f.coordinator.processClaim(claim)).toEqual([
        expect.objectContaining({ requestId: requested.requestId, status: "published" }),
      ]);
      expect(f.runtime.uploaded.get(accepted.sha)).toEqual(Buffer.from("completed turn change\n"));
      expect(f.runtime.uploaded.has(f.first.sha)).toBe(false);
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    },
  );

  it.each([null, "worker-turn", "remote-exec"] as const)(
    "rejects a stale supplied run ID with %s placement while preserving direct session requests",
    async (executionMode) => {
      const f = await repositoryFixture(undefined, REQUEST);
      if (executionMode) {
        await seedPublicationWorker(f.placements, "run-scoped-worker", executionMode);
        await f.placements.claimTurn({
          sessionId: REQUEST.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          claimId: "current-claim",
          runId: "current-run",
          owner: {
            kind: executionMode === "remote-exec" ? "local" : "worker",
            environmentId: "run-scoped-worker",
            ownerEpoch: 7,
          },
        });
      }
      const input = {
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        idempotencyKey: "stale-supplied-run",
      };
      await expect(
        f.coordinator.requestForSessionV2({ ...input, expectedRunId: "stale-run" }),
      ).rejects.toThrow("run identity changed");
      expect(listRepositoryGitHubPublications()).toEqual([]);
      expect(mocks.prepareIdentity).not.toHaveBeenCalled();
      expect(f.runtime.effects).toEqual([]);
      const direct = await f.coordinator.requestForSessionV2(input);
      expect(direct.status).toBe(executionMode ? "requested" : "published");
      expect(readRepositoryGitHubPublication(direct.requestId)?.claim_id).toBeNull();
    },
  );

  it("does not treat a pure Gateway-local claim as a repository worker owner", async () => {
    const f = await repositoryFixture();
    const claim = await f.placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "gateway-local",
      runId: "gateway-local-run",
      owner: { kind: "local" },
    });
    await expect(
      f.coordinator.requestForSessionV2({
        sessionKey: SESSION_KEY,
        agentId: "main",
        expectedRunId: claim.runId,
        idempotencyKey: "gateway-local",
      }),
    ).rejects.toThrow("session authority changed");
    expect(mocks.prepareIdentity).not.toHaveBeenCalled();
    expect(listRepositoryGitHubPublications()).toEqual([]);
  });

  it.each(["mismatched environment", "replaced claim"] as const)(
    "rejects a remote-exec publication with a %s before recording an intent",
    async (mismatch) => {
      const f = await repositoryFixture(undefined, REQUEST);
      await seedPublicationWorker(f.placements, "owned-worker", "remote-exec");
      const input = {
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        claimId: "owned-claim",
        runId: "owned-run",
        owner: { kind: "local" as const, environmentId: "owned-worker", ownerEpoch: 7 },
      };
      const claim = await f.placements.claimTurn(input);
      if (mismatch === "replaced claim") {
        const prepare = mocks.prepareIdentity.getMockImplementation()!;
        mocks.prepareIdentity.mockImplementationOnce(async (...args) => {
          const identity = await prepare(...args);
          await f.placements.releaseTurn(claim);
          await f.placements.claimTurn({
            ...input,
            claimId: "replacement-claim",
            runId: "replacement-run",
          });
          return identity;
        });
      }
      await expect(
        f.coordinator.requestForClaimV2({
          claim:
            mismatch === "mismatched environment"
              ? { ...claim, owner: { ...claim.owner, environmentId: "other-worker" } }
              : claim,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          idempotencyKey: "closed-remote-owner",
        }),
      ).rejects.toThrow("session authority changed");
      expect(listRepositoryGitHubPublications()).toEqual([]);
      expect(f.runtime.effects).toEqual([]);
    },
  );

  it.each(["placement_generation", "environment_id", "owner_epoch"] as const)(
    "does not bind, process, or defer a request whose %s belongs to a different claim",
    async (column) => {
      const f = await repositoryFixture(undefined, REQUEST);
      await seedPublicationWorker(f.placements, "publication-worker");
      const claim = await f.placements.claimTurn({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        claimId: "publication-claim",
        runId: "publication-run",
        owner: { kind: "worker", environmentId: "publication-worker", ownerEpoch: 7 },
      });
      const accepted = await f.coordinator.requestForClaimV2({
        claim,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        idempotencyKey: "different-claim",
      });
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE github_repository_publication_requests SET " + column + " = ? WHERE request_id = ?",
      ).run(column === "environment_id" ? "different-worker" : 999, accepted.requestId);
      await f.coordinator.prepareClaimWorkspace(claim);
      expect(readRepositoryGitHubPublication(accepted.requestId)?.checkpoint_ref).toBeNull();
      expect(await f.coordinator.processClaim(claim)).toEqual([]);
      await f.coordinator.deferClaimPreparationAsync(claim);
      expect(readRepositoryGitHubPublication(accepted.requestId)?.claim_id).toBe(claim.claimId);
      await expect(f.coordinator.deferOrphanedRequestsAsync()).resolves.toBeUndefined();
      expect(readRepositoryGitHubPublication(accepted.requestId)?.claim_id).toBeNull();
      expect(f.runtime.effects).toEqual([]);
    },
  );

  it("does not overwrite a branch changed after observation", async () => {
    const f = await repositoryFixture();
    f.runtime.changeHeadDuringPush = true;
    const result = await f.coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "ref-race",
    });
    expect(result.status).toBe("requested");
    expect(f.runtime.head).toBe("f".repeat(40));
    expect(f.runtime.effects).toEqual([]);
    expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40) });
    expect(listRepositoryGitHubPublications()[0]).toMatchObject({
      last_effect: "push",
      effect_state: "dispatched",
    });
  });

  it.each(["shared", "personal"] as const)(
    "fences a retained %s execution when its session receipts are deleted",
    async (source) => {
      const f = await repositoryFixture();
      f.runtime.interruptPush = true;
      let requestId: string;
      if (source === "personal") {
        const person = await createPersonalPublicationFixture();
        f.runtime.accountId = personalPublicationAccount.accountId;
        const result = await person.coordinator.requestPersonalForSessionV2(
          {
            sessionKey: SESSION_KEY,
            idempotencyKey: "delete-personal",
            selection: {
              source: "personal",
              generation: person.generation,
              account: personalPublicationAccount,
            },
          },
          person.action,
        );
        requestId = result.requestId;
      } else {
        requestId = (
          await f.coordinator.requestForSessionV2({
            agentId: "main",
            sessionKey: SESSION_KEY,
            idempotencyKey: "delete-shared",
          })
        ).requestId;
      }
      const row = readRepositoryGitHubPublication(requestId)!;
      const execution = await claimRepositoryGitHubPublicationAsync(row, "current-instance", {
        assertCustody: () => {},
        assertAction: () => {},
        prepareSource: async () => {
          throw new Error("Unexpected source acquisition");
        },
      });
      const deleteReceipts = await preparePersonalGitHubSessionReceiptDeletion({
        agentId: "main",
        generations: [
          {
            sessionKey: SESSION_KEY,
            sessionId: row.session_id,
            lifecycleRevision: row.session_lifecycle_revision,
          },
        ],
      });
      await deleteReceipts();
      await expect(execution.recordEffect("push")).rejects.toThrow();
      await expect(
        execution.recordEffect("push", { headCommit: "e".repeat(40) }),
      ).rejects.toThrow();
    },
  );
});
