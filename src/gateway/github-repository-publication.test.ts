import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../state/github-personal-publication-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount,
  expectPersonalPublicationReplay,
} from "./github-personal-publication.test-support.js";
import { createGitHubPublicationRecoveryBackoff } from "./github-publication-recovery.js";
import { claimRepositoryGitHubPublicationAsync } from "./github-publication-store-async.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { listRepositoryGitHubPublicationsInDatabase } from "./github-repository-publication-read.worker.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import { captureCheckpoint } from "./github-repository-publication-workspace.js";
import {
  createRepositoryPublicationFixture,
  observeRepositoryCommands,
  repositoryPublicationTestUrl as url,
} from "./github-repository-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";
import { bindRepositoryDiskForTest } from "./worker-environments/repository-disk-authority.test-support.js";

const readReceipt = (requestId: string) =>
  readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);
const listReceipts = (
  filter: Parameters<typeof listRepositoryGitHubPublicationsInDatabase>[1] = {},
) => listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, filter);

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const repositoryFixture = createRepositoryPublicationFixture.bind(undefined, checkpoint);

function assertPublicationAuthority(current: boolean) {
  if (!current) {
    throw new Error("Publication authority closed");
  }
}

async function sourceFixture(source: "shared" | "personal") {
  const f = await repositoryFixture();
  const person = source === "personal" ? await createPersonalPublicationFixture() : undefined;
  if (person) {
    f.runtime.accountId = personalPublicationAccount.accountId;
  }
  const coordinator = person?.coordinator ?? f.coordinator;
  return {
    f,
    person,
    coordinator,
    publish: (key: string, options: Parameters<typeof f.publish>[1] = {}) =>
      person
        ? coordinator.requestPersonalForSessionV2(
            {
              sessionKey: SESSION_KEY,
              idempotencyKey: key,
              selection: {
                source: "personal",
                generation: person.generation,
                account: personalPublicationAccount,
              },
            },
            person.action,
          )
        : f.publish(key, options),
  };
}

async function claimWorker(
  f: Awaited<ReturnType<typeof repositoryFixture>>,
  environmentId: string,
  executionMode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  const owner = { environmentId, ownerEpoch: 7 };
  seedAttachedPlacementEnvironment(openOpenClawStateDatabase(), {
    ...owner,
    sessionId: REQUEST.sessionId,
  });
  await seedActivePlacement(f.placements, { ...owner, executionMode });
  const input: Parameters<typeof f.placements.claimTurn>[0] = {
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    agentId: REQUEST.agentId,
    claimId: environmentId + "-claim",
    runId: environmentId + "-run",
    owner: { kind: executionMode === "remote-exec" ? "local" : "worker", ...owner },
  };
  return { input, claim: await f.placements.claimTurn(input) };
}

function expectUnreported(
  coordinator: ReturnType<typeof createTestGitHubPublicationCoordinator>,
  requestId: string,
) {
  return expect(coordinator.listUnreportedResultsAsync()).resolves.toMatchObject([
    { result: { requestId, status: "failed", code: "unavailable" } },
  ]);
}

function claimReceipt(
  row: Parameters<typeof claimRepositoryGitHubPublicationAsync>[0],
  executionId: string,
) {
  return claimRepositoryGitHubPublicationAsync(row, executionId, {
    assertCustody: () => {},
    assertAction: () => {},
    prepareSource: async () => {
      throw new Error("Unexpected source acquisition");
    },
  });
}

installGitHubPublicationTestHarness();
afterEach(() => vi.unstubAllGlobals());

it("preserves a pinned publication but refuses new publication from a disk repository mirror", async () => {
  const f = await repositoryFixture();
  const published = await f.publish("before-disk-binding");
  const row = readReceipt(published.requestId)!;
  expect(row.checkpoint_ref).toBe(f.first.ref);
  await bindRepositoryDiskForTest(f.workspace, SESSION_ID);
  const selected = await captureCheckpoint(
    row,
    () => {},
    async (facts) => facts,
    {
      assertCustody() {},
      assertAction() {},
      prepareSource: async () => {
        throw new Error("Unexpected source acquisition");
      },
    },
  );
  expect(selected).toMatchObject({
    checkpoint_ref: f.first.ref,
    workspace_tree: f.first.workspaceTree,
  });
  const effects = [...f.runtime.effects];
  await expect(f.publish("after-disk-binding")).rejects.toThrow("requires a fresh snapshot");
  expect(f.runtime.effects).toEqual(effects);
});

it.each(["shared", "personal"] as const)(
  "retains the accepted %s PR response after publication authority closes",
  async (source) => {
    const { f, person, coordinator, publish } = await sourceFixture(source);
    let current = true;
    observeRepositoryCommands((args) => {
      if (args.includes("repos/owner/repository/pulls") && args.includes("POST")) {
        current = false;
        if (person) {
          person.runtime.live = false;
        }
      }
    });
    const request = () =>
      publish("accepted-before-close", {
        assertCurrent: () => assertPublicationAuthority(current),
      });
    const published = await request();
    expect(published).toMatchObject({ status: "published", url });
    expect(readReceipt(published.requestId)).toMatchObject({
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
    receipt: readReceipt(requestId),
    commandCount: mocks.runCommand.mock.calls.length,
    effects: [...f.runtime.effects],
  }));
});

it.each(["shared", "personal"] as const)(
  "records unavailable %s publication without losing its accepted recovery checkpoint",
  async (source) => {
    const { f, person: personal, coordinator, publish } = await sourceFixture(source);
    const retained = await getSessionRepositoryWorkspaceStore().get(f.workspace.workspaceId);
    checkpoint.mockImplementation(async (_request, use) => await use({}));
    const request = () => publish("no-publication-snapshot");
    const result = await request();
    expect(result).toMatchObject({
      status: "failed",
      code: "unavailable",
      nextAction: expect.stringContaining("Git clean filters"),
    });
    expect(readReceipt(result.requestId)).toMatchObject({
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
    await expectUnreported(coordinator, result.requestId);
    expect(f.runtime.effects).toEqual([]);
  },
);

it("cannot record publication unavailability after its accepted checkpoint changes", async () => {
  const f = await repositoryFixture();
  checkpoint.mockImplementationOnce(async (_request, use) => {
    await f.capture("new accepted edit\n", "replacement-checkpoint");
    return await use({});
  });
  await expect(f.publish("changed-unavailable")).rejects.toThrow("checkpoint changed");
  expect(listReceipts()).toMatchObject([
    { status: "requested", error_code: null, last_effect: null },
  ]);
  expect(f.runtime.effects).toEqual([]);
});

it.each(["topic", "refs/tags/release", { kind: "commit" }] as const)(
  "publishes unchanged pinned %j when its merge-base has a different tree",
  async (ref) => {
    const f = await repositoryFixture(ref);
    await f.capture(null, "unchanged-pinned-source");
    f.runtime.baseHead = "d".repeat(40);
    f.runtime.baseHeadTree = "c".repeat(40);
    f.runtime.mergeBase = "e".repeat(40);
    f.runtime.mergeBaseTree = "c".repeat(40);
    const result = await f.publish("related-ref");
    expect(result.status).toBe("published");
    expect(f.runtime.pr?.baseRef).toBe(ref === "topic" ? "topic" : "main");
    expect(f.runtime.uploaded.size).toBe(0);
    expect(readReceipt(result.requestId)?.workspace_tree).toBe(f.baseTree);
    expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40), force: false });
  },
);

it("rejects a missing common ancestor before uploading or changing references", async () => {
  const f = await repositoryFixture();
  f.runtime.commonHistory = false;
  expect((await f.publish("unrelated-ref")).status).toBe("failed");
  expect(f.runtime.uploaded.size).toBe(0);
  expect(f.runtime.effects).toEqual([]);
});

it("distinguishes an unchanged published tree from a complete revert to the PR base", async () => {
  const f = await repositoryFixture();
  expect((await f.publish("before-revert")).status).toBe("published");
  const previousHead = f.runtime.head;
  expect(await f.publish("unchanged-prior-head")).toMatchObject({
    status: "failed",
    code: "no_changes",
  });
  expect(f.casRequests).toHaveLength(1);
  expect(f.runtime.head).toBe(previousHead);
  expect(f.runtime.effects).toEqual(["push", "pull_request"]);
  await f.capture(null, "complete-revert");
  const reverted = await f.publish("complete-revert");
  expect(reverted).toMatchObject({ status: "published", url });
  expect(readReceipt(reverted.requestId)).toMatchObject({
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
  expect(await f.publish("foreign-head-after-revert")).toMatchObject({
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
  await f.publish("before-delete");
  f.runtime.head = null;
  await f.capture("next accepted change\n", "after-delete");
  const result = await f.publish("after-delete");
  expect(result).toMatchObject({ status: "failed", code: "push_rejected" });
  expect(f.runtime.head).toBeNull();
  expect(f.casRequests).toHaveLength(1);
  expect(f.runtime.effects).toEqual(["push", "pull_request"]);
});

it("extends its recorded pushed head after the earlier PR was closed before confirmation", async () => {
  const f = await repositoryFixture();
  f.runtime.closePullRequest = true;
  const failed = await f.publish("closed-before-confirmation");
  expect(failed).toMatchObject({ status: "failed", code: "github_rejected" });
  const pushedHead = f.runtime.head;
  expect(pushedHead).not.toBeNull();
  expect(readReceipt(failed.requestId)).toMatchObject({
    pushed_head_commit: pushedHead,
    last_effect: "pull_request",
    effect_state: "observed",
  });
  f.runtime.closePullRequest = false;
  await f.capture("accepted after closed PR\n", "after-closed-pr");
  expect((await f.publish("fresh-after-closed-pr")).status).toBe("published");
  expect(f.casRequests[1]).toMatchObject({ beforeOid: pushedHead, force: false });
  expect(f.runtime.effects).toEqual(["push", "pull_request", "push", "pull_request"]);
});

it("settles unreadable repository publication without replaying its dispatched push", async () => {
  const f = await repositoryFixture();
  f.runtime.interruptPush = true;
  const first = await f.publish("unconfirmed-repository");
  expect(first.status).toBe("requested");
  const before = readReceipt(first.requestId)!;
  expect(before).toMatchObject({ last_effect: "push", effect_state: "dispatched" });
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (args: string[], ...rest: unknown[]) =>
    args.includes("repos/owner/repository") ? commandResult("", 1) : transport(args, ...rest),
  );
  let now = performance.now();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  onTestFinished(() => clock.mockRestore());
  const coordinator = createTestGitHubPublicationCoordinator({
    placements: f.placements,
    recovery: {
      shared: createGitHubPublicationRecoveryBackoff(),
      repository: createGitHubPublicationRecoveryBackoff(),
    },
  });
  for (const waitMs of [0, 60_000, 120_000]) {
    now += waitMs;
    await coordinator.resumeSessionRequests();
  }
  expect(readReceipt(first.requestId)).toMatchObject({
    status: "failed",
    error_code: "unavailable",
    next_action: expect.stringContaining("unconfirmed"),
    head_commit: before.head_commit,
    last_effect: "push",
    effect_state: "dispatched",
  });
  const calls = mocks.runCommand.mock.calls.length;
  now += 3_600_000;
  await coordinator.resumeSessionRequests();
  expect(mocks.runCommand).toHaveBeenCalledTimes(calls);
  expect(f.runtime.effects).toEqual(["push"]);
});

it("keeps waiting for the first accepted checkpoint without exhausting recovery", async () => {
  const f = await repositoryFixture(undefined, undefined, {}, false);
  const first = await f.publish("waiting-for-checkpoint");
  expect(first.status).toBe("requested");
  let now = performance.now();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  onTestFinished(() => clock.mockRestore());
  const coordinator = createTestGitHubPublicationCoordinator({
    placements: f.placements,
    recovery: {
      shared: createGitHubPublicationRecoveryBackoff(),
      repository: createGitHubPublicationRecoveryBackoff(),
    },
  });
  for (const waitMs of [0, 60_000, 120_000, 3_600_000]) {
    now += waitMs;
    await coordinator.resumeSessionRequests();
  }
  expect(readReceipt(first.requestId)).toMatchObject({
    status: "requested",
    checkpoint_ref: null,
    last_effect: null,
  });
  expect(f.runtime.effects).toEqual([]);
  await f.capture("first accepted checkpoint\n", "ready");
  await coordinator.resumeSessionRequests();
  expect(await coordinator.readAsync(first.requestId)).toMatchObject({
    status: "published",
    url,
  });
});

it("records a recovered push response even when authority closes during its observation", async () => {
  const f = await repositoryFixture();
  f.runtime.interruptPush = true;
  let current = true;
  const request = {
    agentId: "main",
    sessionKey: SESSION_KEY,
    idempotencyKey: "lost-push-response",
    assertCurrent: () => assertPublicationAuthority(current),
  };
  const first = await f.coordinator.requestForSessionV2(request);
  expect(first.status).toBe("requested");
  expect(readReceipt(first.requestId)?.pushed_head_commit).toBeNull();
  f.runtime.afterHeadObservation = () => {
    current = false;
  };
  expect(await f.coordinator.requestForSessionV2(request)).toMatchObject({
    requestId: first.requestId,
    status: "failed",
    code: "identity_changed",
  });
  expect(readReceipt(first.requestId)?.pushed_head_commit).toBe(f.runtime.head);
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
    const { f, person, publish } = await sourceFixture(source);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    observeRepositoryCommands(async (args) => {
      if (args.includes("graphql")) {
        entered.resolve();
        await release.promise;
      }
    });
    const pending = publish("reset-during-push");
    try {
      await entered.promise;
      await expect(
        f.placements.withWorkspaceExclusion(SESSION_ID, async () => {}),
      ).rejects.toThrow();
      await f.closeSession(boundary);
      if (boundary === "move") {
        expect(mocks.loadSession(SESSION_KEY).entry.repositoryWorkspaceId).toBeUndefined();
      }
      const recovering = createTestGitHubPublicationCoordinator({ placements: f.placements });
      await recovering.resumeSessionRequests();
      expect(listReceipts()[0]).toMatchObject({
        status: "publishing",
        last_effect: "push",
        effect_state: "dispatched",
      });
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ status: "failed", code: "session_changed" });
    expect(listReceipts()[0]).toMatchObject({
      status: "failed",
      error_code: "session_changed",
      last_effect: "push",
      effect_state: "observed",
      pushed_head_commit: f.runtime.head,
    });
    expect(f.runtime.effects).toEqual(["push"]);
    if (boundary === "move") {
      if (person) {
        const { coordinator, action } = person;
        const requestId = listReceipts()[0]!.request_id;
        const prepared = await coordinator.preparePersonalStatus(requestId);
        using _ = { [Symbol.dispose]: () => prepared?.release() };
        expect(
          await coordinator.personalStatusAsync(action, action, requestId, prepared),
        ).toMatchObject({
          result: { status: "failed", code: "session_changed" },
          confirmation: null,
        });
      }
      return;
    }
    await f.capture("new session edit\n", "after-reset");
    const next = await f.publish("new-after-reset");
    expect(next.status).toBe("published");
    expect(readReceipt(next.requestId)?.previous_head_commit).toBe(f.casRequests[0]!.afterOid);
  },
);

it.each(["archive", "reset"] as const)(
  "retires a pending receipt after %s and continues a later session's publication",
  async (kind) => {
    const stale = await repositoryFixture();
    stale.runtime.interruptPush = true;
    const first = await stale.publish("stale-before-recovery");
    expect(first.status).toBe("requested");
    const retained = await claimReceipt(readReceipt(first.requestId)!, "retained-execution");
    await stale.closeSession(kind);
    if (kind === "reset") {
      await expect(stale.publish("stale-before-recovery")).rejects.toThrow(
        "session lifecycle changed",
      );
    }
    await stale.coordinator.resumeSessionRequests();
    expect(readReceipt(first.requestId)).toMatchObject({
      status: "failed",
      error_code: "session_changed",
      execution_id: null,
    });
    await expect(
      retained.recordEffect("push", { headCommit: stale.runtime.head! }),
    ).rejects.toThrow();
    expect(stale.runtime.effects).toEqual(["push"]);
    const valid = await repositoryFixture(undefined, {
      sessionId: "valid-later-session",
      sessionKey: "agent:main:valid-later",
    });
    valid.runtime.interruptPush = true;
    const second = await valid.publish("valid-after-stale");
    expect(second.status).toBe("requested");
    await valid.coordinator.resumeSessionRequests();
    expect(readReceipt(second.requestId)?.status).toBe("published");
    expect(valid.runtime.effects).toEqual(["push", "pull_request"]);
  },
);

it.each(["pending result", "reservation", "identity mismatch"] as const)(
  "continues later publications when the first session has a %s and reports hard failures",
  async (blocker) => {
    const blocked = await repositoryFixture(undefined, REQUEST);
    blocked.runtime.interruptPush = true;
    const first = await blocked.publish("blocked-first");
    expect(first.status).toBe("requested");
    const released = createDeferredCore();
    let held: Promise<void> | undefined;
    try {
      if (blocker === "pending result") {
        const { claim: pendingClaim } = await claimWorker(
          blocked,
          "pending-publication-worker",
          "remote-exec",
        );
        await blocked.placements.markWorkspaceResultPending(pendingClaim);
        expect(await blocked.placements.clearLocalTurnClaimsAfterRestartAsync()).toBe(1);
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
      const valid = await repositoryFixture(undefined, {
        sessionId: "valid-after-blocked",
        sessionKey: "agent:main:valid-after-blocked",
      });
      valid.runtime.interruptPush = true;
      const second = await valid.publish("valid-after-blocked");
      expect(second.status).toBe("requested");
      expect(listReceipts({ pending: true }).map((row) => row.request_id)).toEqual([
        first.requestId,
        second.requestId,
      ]);
      const recovery = valid.coordinator.resumeSessionRequests();
      if (blocker === "identity mismatch") {
        await expect(recovery).rejects.toThrow("placement identity changed");
      } else {
        await recovery;
      }
      expect(readReceipt(first.requestId)?.status).toBe("requested");
      expect(readReceipt(second.requestId)?.status).toBe("published");
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
    const { claim } = await claimWorker(f, "in-turn-worker", executionMode);
    const requested = await f.publish("in-turn-" + executionMode, { expectedRunId: claim.runId });
    expect(requested.status).toBe("requested");
    expect(readReceipt(requested.requestId)).toMatchObject({
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
      expect(readReceipt(requested.requestId)).toMatchObject({
        status: "failed",
        error_code: "unavailable",
        last_effect: null,
      });
      await expectUnreported(f.coordinator, requested.requestId);
      expect(f.runtime.effects).toEqual([]);
      return;
    }
    expect(await f.coordinator.processClaim(claim)).toMatchObject([
      { requestId: requested.requestId, status: "published" },
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
      await claimWorker(f, "run-scoped-worker", executionMode);
    }
    await expect(f.publish("stale-supplied-run", { expectedRunId: "stale-run" })).rejects.toThrow(
      "run identity changed",
    );
    expect(listReceipts()).toEqual([]);
    expect(mocks.prepareIdentity).not.toHaveBeenCalled();
    expect(f.runtime.effects).toEqual([]);
    const direct = await f.publish("stale-supplied-run");
    expect(direct.status).toBe(executionMode ? "requested" : "published");
    expect(readReceipt(direct.requestId)?.claim_id).toBeNull();
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
  await expect(f.publish("gateway-local", { expectedRunId: claim.runId })).rejects.toThrow(
    "session authority changed",
  );
  expect(mocks.prepareIdentity).not.toHaveBeenCalled();
  expect(listReceipts()).toEqual([]);
});

it.each(["mismatched environment", "replaced claim"] as const)(
  "rejects a remote-exec publication with a %s before recording an intent",
  async (mismatch) => {
    const f = await repositoryFixture(undefined, REQUEST);
    const { input, claim } = await claimWorker(f, "owned-worker", "remote-exec");
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
    expect(listReceipts()).toEqual([]);
    expect(f.runtime.effects).toEqual([]);
  },
);

it.each(["placement_generation", "environment_id", "owner_epoch"] as const)(
  "does not bind, process, or defer a request whose %s belongs to a different claim",
  async (column) => {
    const f = await repositoryFixture(undefined, REQUEST);
    const { claim } = await claimWorker(f, "publication-worker");
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
    expect(readReceipt(accepted.requestId)?.checkpoint_ref).toBeNull();
    expect(await f.coordinator.processClaim(claim)).toEqual([]);
    await f.coordinator.deferClaimPreparationAsync(claim);
    expect(readReceipt(accepted.requestId)?.claim_id).toBe(claim.claimId);
    await expect(f.coordinator.deferOrphanedRequestsAsync()).resolves.toBeUndefined();
    expect(readReceipt(accepted.requestId)?.claim_id).toBeNull();
    expect(f.runtime.effects).toEqual([]);
  },
);

it("does not overwrite a branch changed after observation", async () => {
  const f = await repositoryFixture();
  f.runtime.changeHeadDuringPush = true;
  expect((await f.publish("ref-race")).status).toBe("requested");
  expect(f.runtime.head).toBe("f".repeat(40));
  expect(f.runtime.effects).toEqual([]);
  expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40) });
  expect(listReceipts()[0]).toMatchObject({
    last_effect: "push",
    effect_state: "dispatched",
  });
});

it.each(["shared", "personal"] as const)(
  "fences a retained %s execution when its session receipts are deleted",
  async (source) => {
    const { f, publish } = await sourceFixture(source);
    f.runtime.interruptPush = true;
    const { requestId } = await publish(`delete-${source}`);
    const row = readReceipt(requestId)!;
    const execution = await claimReceipt(row, "current-instance");
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
    await expect(execution.recordEffect("push", { headCommit: "e".repeat(40) })).rejects.toThrow();
  },
);
