// Register transport fixtures before the publication owners load.
// oxfmt-ignore
import {
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "../state/openclaw-state-schema.test-support.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { digestGitHubPublicationRequest } from "./github-publication-receipt.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPublicationFixture,
  guestScopes,
  holdWorkerTurn,
} from "./github-publication-requester.test-support.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./worker-environments/session-repository-checkpoints.js")
  >()),
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const creations = () =>
  mocks.runCommand.mock.calls.filter(
    ([args]) => args.includes("POST") && args.some((arg: string) => arg.endsWith("/pulls")),
  );

describe("publication draft choice", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      [undefined, false, true].map((draft) => ({ backend, draft })),
    ),
  )(
    "preserves $backend draft=$draft through deferred admission and restart",
    async ({ backend, draft }) => {
      const f = await createRequesterPublicationFixture(checkpoint, backend);
      const claim = await holdWorkerTurn(f);
      const request = {
        ...f.request("draft-choice", f.guest),
        ...(draft !== undefined ? { draft } : {}),
      };
      const accepted = await f.coordinator.requestForSessionV2(request);
      expect(accepted.status).toBe("requested");
      expect(f.readReceipt(accepted.requestId)).toMatchObject({ draft: draft === true ? 1 : 0 });
      expect(creations()).toHaveLength(0);
      await expect(
        f.coordinator.requestForSessionV2({ ...request, draft: draft !== true }),
      ).rejects.toThrow("idempotency key was reused");
      await f.placements.releaseTurn(claim);
      f.guestSource.release();
      f.maintainerSource.release();
      await closeStateDatabaseForTest();
      const restarted = f.restart();
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(accepted.requestId)).toMatchObject({ status: "published" });
      const posts = creations();
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0]![1]!.input!)).toMatchObject({ draft: draft === true });
    },
  );

  it.each(["local", "repository"] as const)(
    "retains legacy accepted draft behavior after %s recovery",
    async (backend) => {
      const f = await createRequesterPublicationFixture(checkpoint, backend);
      const claim = await holdWorkerTurn(f);
      const accepted = await f.coordinator.requestForSessionV2(f.request("legacy", f.guest));
      const row = f.readReceipt(accepted.requestId)!;
      const digest =
        "workspace_id" in row
          ? repositoryGitHubPublicationDigest({ ...row, draft: null })
          : digestGitHubPublicationRequest({
              sessionId: row.session_id,
              idempotencyKey: row.idempotency_key,
              title: row.title ?? undefined,
              body: row.body ?? undefined,
            });
      await f.placements.releaseTurn(claim);
      f.guestSource.release();
      f.maintainerSource.release();
      await closeStateDatabaseForTest();
      // Recreate an accepted pre-option row after schema migration: draft stays NULL.
      // The state migration suite owns historical DDL; recovery consumes its current-schema row.
      {
        using db = new DatabaseSync(f.database.path);
        addPreCutoverClientCredentialTablesForTest(db);
        const table =
          backend === "local"
            ? "github_publication_requests"
            : "github_repository_publication_requests";
        db.prepare(`UPDATE ${table} SET request_digest = ?, draft = NULL WHERE request_id = ?`).run(
          digest,
          accepted.requestId,
        );
      }
      retireSqliteDatabaseAdmissionForPath(f.database.path);
      await withStateMigrationBackupForTest({ path: f.database.path }, async () => {
        openOpenClawStateDatabase();
        await closeStateDatabaseForTest();
      });
      const restarted = f.restart();
      expect(f.readReceipt(accepted.requestId)).toMatchObject({
        draft: null,
        request_digest: digest,
      });
      const resumed = await createGitHubPublicationRequesterFixture({
        profileId: f.guestProfile,
        scopes: guestScopes,
        ...f.guestSource.session,
      });
      const retried = await restarted.requestForSessionV2(f.request("legacy", resumed.requester));
      expect(retried.requestId).toBe(accepted.requestId);
      await restarted.resumeSessionRequests();
      expect(await restarted.readAsync(accepted.requestId)).toMatchObject({ status: "published" });
      expect(f.readReceipt(accepted.requestId)).toMatchObject({ draft: null });
      expect(creations()).toHaveLength(1);
      expect(JSON.parse(creations()[0]![1]!.input!)).toMatchObject({ draft: true });
    },
  );

  it("updates an existing draft without creating another PR or changing its state", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "repository");
    const first = await f.coordinator.requestForSessionV2({
      ...f.request("draft", f.guest),
      draft: true,
    });
    expect(first.status).toBe("published");
    expect(creations()).toHaveLength(1);
    expect(JSON.parse(creations()[0]![1]!.input!)).toMatchObject({ draft: true });
    await f.repository!.capture("next accepted change\n", "next-change");
    const callCount = mocks.runCommand.mock.calls.length;
    const second = await f.coordinator.requestForSessionV2({
      ...f.request("update", f.guest),
      draft: false,
    });
    expect(second).toMatchObject({
      status: "published",
      url: first.status === "published" ? first.url : undefined,
    });
    expect(creations()).toHaveLength(1);
    const effects = mocks.runCommand.mock.calls
      .slice(callCount)
      .filter(
        ([args]) => args.includes("POST") || args.includes("PATCH") || args.includes("graphql"),
      );
    for (const [args, options] of effects) {
      if (args.includes("graphql")) {
        expect(JSON.parse(options?.input ?? "{}").query).toBe(
          "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
        );
      } else {
        expect(args.some((arg: string) => arg.includes("/git/"))).toBe(true);
      }
    }
  });
});
