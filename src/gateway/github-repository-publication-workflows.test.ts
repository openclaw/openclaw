// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { captureGitHubPublicationRequester } from "./github-publication-requester.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import * as repositoryPublicationExecutor from "./github-repository-publication-executor.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

const workflow = ".github/workflows/example.yaml";
const definition = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
const createFixture = async (baseFiles: Record<string, string> = {}, requestedRef?: string) => {
  const f = await createRequesterPublicationFixture(
    checkpoint,
    "repository",
    { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
    { baseFiles, requestedRef },
  );
  if (!f.repository) {
    throw new Error("Expected a repository publication fixture.");
  }
  return { ...f, repository: f.repository };
};
const writes = () => mocks.runCommand.mock.calls.filter(([args]) => args.includes("POST"));

describe("repository checkpoint workflow authority", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["ordinary", "add", "modify", "delete"] as const)(
    "denies narrow publication of %s changes and retains the checkpoint",
    async (operation) => {
      const f = await createFixture(
        operation === "modify" || operation === "delete" ? { [workflow]: definition } : {},
      );
      const saved = await f.repository.capture(
        "accepted code\n",
        operation,
        operation === "ordinary"
          ? {}
          : { [workflow]: operation === "delete" ? null : definition + "# accepted change\n" },
      );
      await expect(
        captureGitHubPublicationRequester(f.guestSource, f.guestSource.session),
      ).rejects.toThrow(GitHubPublicationRequesterUnavailableError);
      expect(writes()).toEqual([]);
      expect(f.repository.runtime.effects).toEqual([]);
      expect(
        (await getSessionRepositoryWorkspaceStore().get(f.repository.workspace.workspaceId))
          ?.checkpointRef,
      ).toBe(saved.ref);
    },
  );

  it.each(["ordinary", "add", "modify", "delete"] as const)(
    "publishes an authorized %s checkpoint from the guest-origin thread",
    async (operation) => {
      const f = await createFixture(
        operation === "modify" || operation === "delete" ? { [workflow]: definition } : {},
      );
      await f.repository.capture(
        "accepted code\n",
        operation,
        operation === "ordinary"
          ? {}
          : { [workflow]: operation === "delete" ? null : definition + "# accepted change\n" },
      );
      expect(
        await f.coordinator.requestForSession(f.request(operation, f.publisher)),
      ).toMatchObject({ status: "published" });
      expect(f.repository.runtime.effects).toEqual(["push", "pull_request"]);
    },
  );

  it("rechecks publication authority after a blob response before writing the tree or branch", async () => {
    const f = await createFixture();
    await f.repository.capture("accepted code\n", "authority-change", { [workflow]: definition });
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.some((arg: string) => arg.endsWith("/git/blobs"))) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    expect(
      await f.coordinator.requestForSession(f.request("authority-change", f.maintainer)),
    ).toMatchObject({ status: "failed", code: "identity_changed" });
    expect(f.repository.runtime.uploaded.size).toBeGreaterThan(0);
    expect(f.repository.runtime.effects).toEqual([]);
    expect(writes().every(([args]) => args.some((arg: string) => arg.endsWith("/git/blobs")))).toBe(
      true,
    );
  });

  it("rechecks the publisher after recording the ref update effect", async () => {
    const f = await createFixture();
    await f.repository.capture("accepted code\n", "publisher-at-ref", { [workflow]: definition });
    const execute = repositoryPublicationExecutor.executeRepositoryGitHubPublication;
    let publisherRevoked = false;
    const intercepted = vi
      .spyOn(repositoryPublicationExecutor, "executeRepositoryGitHubPublication")
      .mockImplementation((params) =>
        execute({
          ...params,
          execution: {
            ...params.execution,
            recordEffect: (effect, observed) => {
              params.execution.recordEffect(effect, observed);
              if (effect === "push" && observed === undefined) {
                publisherRevoked = true;
                mocks.matchesIdentity.mockReturnValue(false);
              }
            },
          },
        }),
      );
    onTestFinished(() => intercepted.mockRestore());

    expect(
      await f.coordinator.requestForSession(f.request("publisher-at-ref", f.maintainer)),
    ).toMatchObject({ status: "requested" });
    expect(publisherRevoked).toBe(true);
    expect(f.maintainer.assertCurrent).not.toThrow();
    expect(f.repository.runtime.uploaded.size).toBeGreaterThan(0);
    expect(f.repository.casRequests).toEqual([]);
    expect(f.repository.runtime.effects).toEqual([]);
  });
});
