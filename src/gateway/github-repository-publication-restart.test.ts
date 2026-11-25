import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
  restartPersonalPublicationFixture,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { readGitHubRepositoryPublicationMetadata } from "./github-repository-publication-snapshot.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import {
  createRepositoryPublicationFixture,
  repositoryPublicationTestUrl as url,
} from "./github-repository-publication.test-support.js";
import type { PrepareRepositoryPublicationIntegration } from "./repository-publication-integration.js";

const readRepositoryGitHubPublication = (requestId: string) =>
  readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic checkpoints isolate publication from real repository and session state.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

// Cold reset imports are fixture preparation, outside the publication behavior's test budget.
await import("./session-reset-service.js");
await import("../agents/embedded-agent.js");

installGitHubPublicationTestHarness();
afterEach(() => vi.unstubAllGlobals());
it("fences publication reservations when the Gateway owner restarts", async () => {
  await createRepositoryPublicationFixture(checkpoint);
  const person = await createPersonalPublicationFixture();
  const previous = person.placements;
  await expect(
    previous.withWorkspaceExclusion(SESSION_ID, async (assertOwned) => {
      await restartPersonalPublicationFixture(person);
      expect(assertOwned).toThrow("was aborted");
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
  await expect(previous.withWorkspaceExclusion(SESSION_ID, async () => {})).rejects.toMatchObject({
    code: "OPENCLAW_STATE_LEASE_ABORTED",
  });
  await person.placements.withWorkspaceExclusion(SESSION_ID, async (assertOwned) => assertOwned());
});

it.each(["reset", "move", "held", "store-busy", "retired-owner"] as const)(
  "requires the same personal owner after restart and a later %s",
  async (boundary) => {
    const f = await createRepositoryPublicationFixture(checkpoint);
    const person = await createPersonalPublicationFixture();
    f.runtime.accountId = personalPublicationAccount.accountId;
    f.runtime.interruptPush = true;
    const selection = { generation: person.generation, account: personalPublicationAccount };
    const request = {
      sessionKey: SESSION_KEY,
      idempotencyKey: "personal",
      selection: {
        source: "personal",
        ...selection,
      },
    };
    const [ok, first, error] = await callPersonalPublicationRpc(
      person,
      "sessions.github.publish",
      request,
    );
    expect(ok, JSON.stringify(error)).toBe(true);
    const id = first.requestId;
    expect(first.status).toBe("needs_confirmation");
    const original = readRepositoryGitHubPublication(id)!;
    expect(original.pushed_head_commit).toBeNull();
    await f.capture("later unselected change\n", "later");
    const retiredCoordinator = person.coordinator;
    await restartPersonalPublicationFixture(person);
    const preparedStatus = await person.coordinator.preparePersonalStatus(id);
    using _ = { [Symbol.dispose]: () => preparedStatus?.release() };
    const status = (action = person.action) =>
      person.coordinator.personalStatusAsync(action, person.action, id, preparedStatus);
    const receipt = () => readRepositoryGitHubPublication(id);
    const pending = await status();
    expect(pending?.confirmation?.workspaceTree).toBe(f.first.workspaceTree);
    await expect(status({ ...person.action, owner: person.otherOwner })).rejects.toThrow();
    const sessionChanged = {
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    };
    if (boundary === "move") {
      await f.closeSession("move");
      expect(mocks.loadSession(SESSION_KEY).entry.repositoryWorkspaceId).toBeUndefined();
      expect(await status()).toMatchObject(sessionChanged);
      return;
    }
    if (boundary === "reset") {
      await f.closeSession("reset");
      const response = await callPersonalPublicationRpc(person, "sessions.github.status", {
        sessionKey: SESSION_KEY,
        requestId: id,
      });
      expect(response[1]).toMatchObject(sessionChanged);
    }
    const database = openOpenClawStateDatabase();
    const now = Date.now();
    const holder = { owner: "previous-publication-owner", epoch: now };
    let writer: DatabaseSync | undefined;
    if (boundary === "held") {
      database.db
        .prepare(
          "INSERT INTO state_leases (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
        )
        .run("session-workspace-action", SESSION_ID, holder.owner, now + 60000, now, now, now);
    } else if (boundary === "store-busy") {
      expect(
        database.db
          .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
          .all("session-workspace-action", SESSION_ID),
      ).toEqual([]);
      // Restarted agent workers release their leases through shared state.
      await closeOpenClawAgentDatabasesAsync(root);
      writer = new DatabaseSync(database.path);
      writer.exec("BEGIN IMMEDIATE");
    }
    const confirmation = {
      sessionKey: SESSION_KEY,
      requestId: id,
      ...selection,
      requestDigest: pending!.confirmation!.requestDigest,
    };
    const confirm = () =>
      callPersonalPublicationRpc(person, "sessions.github.confirm", confirmation);
    if (boundary === "retired-owner") {
      const aborted = await callPersonalPublicationRpc(
        { ...person, coordinator: retiredCoordinator },
        "sessions.github.confirm",
        confirmation,
      );
      expect(aborted[0]).toBe(false);
      expect(aborted[2]).toMatchObject({ code: "UNAVAILABLE", retryable: false });
      expect(aborted[2].details.leaseAcquisition).toMatchObject({
        kind: "aborted",
        reason: "caller-signal",
        elapsedMs: expect.any(Number),
      });
      expect(aborted[2].details.leaseAcquisition.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(f.runtime.effects).toEqual(["push"]);
      expect(receipt()?.checkpoint_ref).toBe(original.checkpoint_ref);
    }
    let confirmed = await confirm().finally(() => {
      writer?.exec("ROLLBACK");
      writer?.close();
    });
    if (boundary === "held" || boundary === "store-busy") {
      const held = boundary === "held";
      expect(confirmed[0]).toBe(false);
      expect(confirmed[2]).toMatchObject({
        code: held ? "FORBIDDEN" : "UNAVAILABLE",
        retryable: !held,
      });
      expect(confirmed[2].details.leaseAcquisition).toMatchObject(
        held ? { kind: "held", holder } : { kind: "store-unavailable", reason: "sqlite-busy" },
      );
      if (held) {
        expect(confirmed[2].message).toEqual(
          expect.stringContaining(`${holder.owner} (lease epoch ${holder.epoch})`),
        );
      }
      expect(f.runtime.effects).toEqual(["push"]);
      expect(receipt()).toEqual(original);
      if (held) {
        return;
      }
      confirmed = await confirm();
    }
    if (boundary === "reset") {
      expect(confirmed[0]).toBe(false);
      expect(confirmed[2]).toMatchObject({ code: "FORBIDDEN" });
      expect(f.runtime.effects).toEqual(["push"]);
      return;
    }
    expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
    expect(confirmed[1]).toMatchObject({ status: "published", url });
    expect(receipt()).toMatchObject({
      checkpoint_ref: original.checkpoint_ref,
      pushed_head_commit: f.runtime.head,
    });
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    expect(f.runtime.uploaded.size).toBe(1);
  },
);

it.each(["error", "api"] as const)(
  "retries the same accepted shared checkpoint after a pre-effect %s outage",
  async (kind) => {
    const f = await createRepositoryPublicationFixture(checkpoint);
    const transport = mocks.runCommand.getMockImplementation()!;
    let unavailable = true;
    mocks.runCommand.mockImplementation(async (args: string[], options) => {
      if (unavailable && args.some((arg) => arg.endsWith("/git/blobs"))) {
        if (kind === "error") {
          throw new Error("Temporary fixture outage");
        }
        return {
          ...commandResult("", 1),
          stderr: Buffer.from("private credential output (HTTP 503)"),
        };
      }
      return transport(args, options);
    });
    const failed = await f.publish("retry-original", { title: "Original request" });
    expect(failed).toMatchObject({ status: "failed", code: "unavailable" });
    expect(f.runtime.effects).toEqual([]);
    if (kind === "api") {
      expect(failed).toMatchObject({ nextAction: expect.stringContaining("HTTP 503") });
      expect(JSON.stringify(failed)).not.toContain("private credential output");
    }
    const accepted = readRepositoryGitHubPublication(failed.requestId)!;
    expect(accepted.checkpoint_ref).toBe(f.first.ref);
    unavailable = false;
    await expect(f.publish("retry-original", { title: "Different request" })).rejects.toThrow(
      "idempotency key was reused",
    );
    const result = await f.publish("retry-original", { title: "Original request" });
    expect(result).toMatchObject({ status: "published", requestId: failed.requestId, url });
    expect(readRepositoryGitHubPublication(failed.requestId)).toMatchObject({
      request_digest: accepted.request_digest,
      checkpoint_ref: accepted.checkpoint_ref,
      checkpoint_digest: accepted.checkpoint_digest,
      previous_head_commit: accepted.previous_head_commit,
    });
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
  },
);

it("reconciles an integrated managed head without replacing the original checkpoint or PR", async () => {
  const f = await createRepositoryPublicationFixture(checkpoint);
  const transport = mocks.runCommand.getMockImplementation()!;
  let first = true;
  mocks.runCommand.mockImplementation(async (args: string[], options) => {
    if (first && args.some((arg) => arg.endsWith("/git/blobs"))) {
      first = false;
      throw new Error("Temporary fixture outage");
    }
    return transport(args, options);
  });
  const failed = await f.publish("original-integrated", { body: "Original description" });
  expect(failed.status).toBe("failed");
  const accepted = readRepositoryGitHubPublication(failed.requestId)!;
  const upstream = f.git(["hash-object", "-w", "--stdin"], "upstream change\n");
  f.git(["read-tree", f.baseTree]);
  f.git(["update-index", "--add", "--cacheinfo", `100644,${upstream},upstream.txt`]);
  f.runtime.baseHeadTree = f.git(["write-tree"]);
  f.runtime.baseHead = f.git(
    ["commit-tree", f.runtime.baseHeadTree, "-p", f.baseCommit],
    "Advance main\n",
  );
  f.git(["update-index", "--add", "--cacheinfo", `100644,${f.first.sha},counter.txt`]);
  const integratedTree = f.git(["write-tree"]);
  expect(integratedTree).not.toBe(accepted.workspace_tree);
  // The worker response includes an independent upstream file, not just the saved input tree.
  const integrate: PrepareRepositoryPublicationIntegration = async (_identity, input) => {
    const { snapshot } = await readGitHubRepositoryPublicationMetadata(
      input.snapshotRoot,
      input.snapshotDigest,
    );
    input.assertCurrent();
    return {
      snapshot: {
        ...snapshot,
        baseCommit: input.targetCommit,
        baseTree: f.runtime.baseHeadTree,
        workspaceTree: integratedTree,
      },
      snapshotRoot: input.snapshotRoot,
      release: async () => {},
    };
  };
  mocks.prepareRepositoryIntegration.mockImplementation(integrate);
  expect(
    (await f.publish("later-integrated", { body: "Keep the published description" })).status,
  ).toBe("published");
  const previousHead = f.runtime.head!;
  const previousBody = f.runtime.pr!.body;
  f.runtime.interruptPush = true;
  const retry = await f.publish("original-integrated", { body: "Original description" });
  expect(retry).toMatchObject({ status: "requested", requestId: failed.requestId });
  await f.coordinator.resumeSessionRequests();
  expect(readRepositoryGitHubPublication(failed.requestId)).toMatchObject({
    status: "published",
    checkpoint_digest: accepted.checkpoint_digest,
    workspace_tree: accepted.workspace_tree,
    previous_head_commit: accepted.previous_head_commit,
  });
  expect(f.runtime.pr!.body).toBe(previousBody);
  expect(f.git(["rev-parse", `${f.runtime.head}^1`])).toBe(previousHead);
  expect(f.runtime.effects).toEqual(["push", "pull_request", "push"]);
});
