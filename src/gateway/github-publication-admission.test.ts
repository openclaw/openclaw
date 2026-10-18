import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
  personalPublicationRequest,
} from "./github-personal-publication.test-support.js";
import { readPersonalGitHubPublicationAsync } from "./github-publication-store-async.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commands,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistClaimPublicationWorkspace,
} from "./github-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const mocks = githubPublicationTestMocks();
const publisher = { source: "system-configured" as const, accountId: 42, login: "roboclaw-bot" };
const obsolete = { ...publisher, accountId: 41, login: "previous-publisher" };
const rejection = (idempotencyKey: string) => ({
  code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
  idempotencyKey,
});

async function sharedAdmission(
  surface: "local" | "deferred" | "claim",
  environmentId = "publication-worker",
) {
  if (surface !== "local") {
    await persistClaimPublicationWorkspace();
  }
  const database = openOpenClawStateDatabase();
  const db = database.db;
  const placements = createWorkerSessionPlacementStore({ database });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  const sessionId = surface === "local" ? SESSION_ID : REQUEST.sessionId;
  const sessionKey = surface === "local" ? SESSION_KEY : REQUEST.sessionKey;
  const claimTurn = (claimId: string, runId: string) =>
    placements.claimTurn({
      sessionId,
      sessionKey,
      agentId: "main",
      claimId,
      runId,
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
  if (surface !== "local") {
    seedAttachedPlacementEnvironment(database, {
      environmentId,
      sessionId,
      ownerEpoch: 2,
    });
    await seedActivePlacement(placements, { environmentId, ownerEpoch: 2 });
  }
  const claim =
    surface === "claim" ? await claimTurn("publication-claim", "publication-run") : undefined;
  const key = `selected-${surface}`;
  const request = { sessionKey, agentId: "main", idempotencyKey: key };
  const requestClaim = (turn: Awaited<ReturnType<typeof claimTurn>>, idempotencyKey: string) =>
    coordinator.requestForClaimV2({ ...request, claim: turn, idempotencyKey });
  return {
    db,
    key,
    placements,
    claimTurn,
    requestClaim,
    read: (idempotencyKey = key) => readGitHubPublicationRequest(db, { sessionId, idempotencyKey }),
    request: (expected = obsolete) =>
      claim
        ? coordinator.requestForClaimV2({
            ...request,
            claim,
            expectedPublisher: expected,
          })
        : coordinator.requestForSessionV2({
            ...request,
            selection: { source: "shared", expected },
          }),
  };
}

function holdIdentity(identity: unknown) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  mocks.prepareIdentity.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return identity;
  });
  return { entered, release };
}

describe("GitHub publication selection admission", () => {
  installGitHubPublicationTestHarness();
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a stale turn claim after awaited identity verification", async () => {
    const { read, placements, requestClaim, claimTurn } = await sharedAdmission(
      "deferred",
      "environment-1",
    );
    const claim = await claimTurn("claim-1", "run-1");
    const { entered, release } = holdIdentity(await mocks.prepareIdentity());
    const pending = requestClaim(claim, "publish-stale").catch((error: unknown) => error);
    let result: unknown;
    try {
      await Promise.race([
        entered.promise,
        pending.then((error) => {
          throw error;
        }),
      ]);
      await placements.releaseTurn(claim);
    } finally {
      release.resolve();
      result = await pending;
    }

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: "GitHub publication lost the live session turn claim after verification.",
    });
    expect(read("publish-stale")).toBeUndefined();
    expect(commands).toEqual([]);
  });

  it("rejects reuse of a worker publication idempotency key by a later turn", async () => {
    const { placements, requestClaim, claimTurn } = await sharedAdmission(
      "deferred",
      "environment-idempotency",
    );
    const firstClaim = await claimTurn("claim-first", "run-first");
    await requestClaim(firstClaim, "reused-worker-call");
    await placements.releaseTurn(firstClaim);
    const secondClaim = await claimTurn("claim-second", "run-second");

    await expect(requestClaim(secondClaim, "reused-worker-call")).rejects.toThrow(
      "idempotency key was reused",
    );
  });

  it.each([
    ["publish", "agent:main:main", "research", undefined],
    ["publish", "global", "---", undefined],
    ["publish", "global", "retired", undefined],
    ["publish", "agent:research:main", "research", "ops"],
    ["publish", "agent:research:main", "research", "retired"],
    ["status", "agent:main:main", "research", undefined],
  ] as const)(
    "rejects %s for %s owned by %s (fixed owner: %s)",
    async (method, sessionKey, agentId, fixedOwner) => {
      const fixture = await createPersonalPublicationFixture();
      fixture.config.agents = {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        ...(fixedOwner ? { defaults: { sessionStore: { agentId: fixedOwner } } } : {}),
      };
      if (fixedOwner) {
        fixture.config.session = { scope: "global", store: "/synthetic/fixed.sqlite" };
      }
      fixture.client.connect.scopes = ["operator.admin"];
      const stopEffect = () => {
        throw new Error("Publication effect reached before owner validation");
      };
      const effects = (["requestPersonalForSessionV2", "confirmPersonalV2"] as const).map(
        (effect) => vi.spyOn(fixture.coordinator, effect).mockImplementation(stopEffect),
      );
      const params = {
        ...(method === "publish"
          ? personalPublicationRequest(fixture, "invalid-owner")
          : { requestId: fixture.generation }),
        sessionKey,
        agentId,
      };
      const response = await callPersonalPublicationRpc(
        fixture,
        `sessions.github.${method}`,
        params,
      );
      expect
        .soft(response)
        .toMatchObject([
          false,
          undefined,
          { code: "INVALID_REQUEST", message: expect.stringMatching(/agent/i) },
        ]);
      effects.forEach((effect) => expect.soft(effect).not.toHaveBeenCalled());
      expect(commands).toEqual([]);
    },
  );

  it.each(["local", "deferred"] as const)(
    "does not reinterpret an existing %s receipt as a pre-admission rejection",
    async (surface) => {
      const fixture = await sharedAdmission(surface);
      await fixture.request(publisher);
      const before = fixture.read();
      const effects = [...commands];
      const error = await fixture.request().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("rejection.idempotencyKey");
      expect(fixture.read()).toEqual(before);
      expect(commands).toEqual(effects);
    },
  );

  it("observes a same-key claim admission committed while identity preparation awaits", async () => {
    const fixture = await sharedAdmission("claim");
    const { entered, release } = holdIdentity(await mocks.prepareIdentity());
    const stale = fixture.request().catch((caught: unknown) => caught);
    await entered.promise;
    let admitted;
    try {
      admitted = await fixture.request(publisher);
    } finally {
      release.resolve();
    }
    const error = await stale;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("rejection.idempotencyKey");
    expect(fixture.read()?.request_id).toBe(admitted.requestId);
    expect(commands).toEqual([]);
  });

  it("does not make a key-wide promise when another invocation is still preparing", async () => {
    const fixture = await sharedAdmission("local");
    const { entered, release } = holdIdentity(await mocks.prepareIdentity());
    const pending = fixture.request(publisher);
    await entered.promise;
    let error: unknown;
    try {
      error = await fixture.request().catch((caught: unknown) => caught);
      expect(fixture.read()).toBeUndefined();
    } finally {
      release.resolve();
    }
    const admitted = await pending;
    expect(error).toMatchObject({ rejection: rejection(fixture.key) });
    expect(fixture.read()?.request_id).toBe(admitted.requestId);
    expect(commands.filter((args) => args.includes("push"))).toHaveLength(1);
    expect(commands.filter((args) => args.includes("POST"))).toHaveLength(1);
  });

  it("does not forget a receipt already observed before an awaited identity refresh", async () => {
    const fixture = await sharedAdmission("deferred");
    await fixture.request(publisher);
    mocks.refreshIdentity.mockImplementationOnce(async () => {
      fixture.db
        .prepare("DELETE FROM github_publication_requests WHERE idempotency_key = ?")
        .run(fixture.key);
    });
    const error = await fixture.request().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("rejection.idempotencyKey");
    expect(fixture.read()).toBeUndefined();
    expect(commands).toEqual([]);
  });

  it("returns exact personal pre-insert rejection details when selection changes during snapshot capture", async () => {
    const fixture = await createPersonalPublicationFixture();
    const key = "personal-rejected-snapshot";
    const request = personalPublicationRequest(fixture, key);
    const rotate = () =>
      updateUserGitHubConnection(
        fixture.owner,
        (current) => ({ ...current!, generation: "f7cb52c6-1d4f-4012-aeae-e31b00f41456" }),
        () => {},
      );
    const run = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args: string[], options?: { input?: string }) => {
      const result = await run(args, options);
      if (args.includes("write-tree")) {
        rotate();
      }
      return result;
    });
    const response = await callPersonalPublicationRpc(fixture, "sessions.github.publish", request);
    expect(response[0]).toBe(false);
    expect(
      await readPersonalGitHubPublicationAsync(fixture.owner, {
        sessionId: SESSION_ID,
        idempotencyKey: key,
      }),
    ).toBeUndefined();
    expect(commands.some((args) => args.includes("push") || args.includes("POST"))).toBe(false);
    expect(response).toMatchObject([false, undefined, { details: rejection(key) }]);
  });

  it("keeps an accepted personal pre-claim identity stop attached to its durable receipt", async () => {
    const fixture = await createPersonalPublicationFixture();
    const { coordinator, action } = fixture;
    fixture.runtime.verifiedAccount = { ...personalPublicationAccount, login: "renamed-account" };
    const key = "accepted-personal-pre-claim";
    const response = await callPersonalPublicationRpc(
      fixture,
      "sessions.github.publish",
      personalPublicationRequest(fixture, key),
    );
    expect(response[0]).toBe(false);
    expect(response[2]).not.toHaveProperty("details");
    const row = await readPersonalGitHubPublicationAsync(fixture.owner, {
      sessionId: SESSION_ID,
      idempotencyKey: key,
    });
    expect(row).toMatchObject({ status: "requested", execution_id: null });
    expect(
      await coordinator.personalStatusAsync(action, action, row!.request_id, undefined),
    ).toMatchObject({
      result: { status: "failed", code: "identity_changed" },
      confirmation: null,
    });
    const options = await callPersonalPublicationRpc(fixture, "sessions.github.options");
    expect(options[0]).toBe(true);
    expect(options[1].pendingPersonal).toMatchObject({ result: { requestId: row!.request_id } });
    expect(commands.some((args) => args.includes("push") || args.includes("POST"))).toBe(false);
  });
});
