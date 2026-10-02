// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { describe, expect, it } from "vitest";
import { prepareCurrentGitHubPublicationIdentity } from "./github-publication-availability.js";
import {
  assertGitHubPublicationReviewedTarget,
  readGitHubPublicationReviewTarget,
} from "./github-publication-review-target.js";
const mocks = githubPublicationTestMocks();
const target = {
  pushRepository: "openclaw/openclaw",
  repository: "openclaw/openclaw",
  branch: "topic",
  baseBranch: "main",
};
const reviewed = {
  ...target,
  pushRepositoryId: 1001,
  repositoryId: 1001,
  baseCommit: "a".repeat(40),
  remoteHeadCommit: null,
};
describe("reviewed GitHub destination", () => {
  installGitHubPublicationTestHarness();
  it.each([
    { refs: [] },
    { refs: [{ ref: "refs/heads/topic-other", object: { sha: "b".repeat(40) } }] },
  ])(
    "projects canonical fields and treats only an exact branch match as present: %j",
    async ({ refs }) => {
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (args, opts) =>
        args.some((arg: string) => arg.includes("/git/matching-refs/"))
          ? commandResult(JSON.stringify(refs))
          : await transport(args, opts),
      );
      const localTarget = { ...target, pushOwner: "openclaw" };
      expect(
        await readGitHubPublicationReviewTarget({
          target: localTarget,
          identity: await prepareCurrentGitHubPublicationIdentity("main"),
          assertCurrent: () => {},
        }),
      ).toEqual(reviewed);
    },
  );
  it.each([0, -1, 1.2, "1001", null])("rejects invalid immutable repository ID %j", async (id) => {
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, opts) =>
      args.includes("{id}") ? commandResult(JSON.stringify({ id })) : await transport(args, opts),
    );
    await expect(
      readGitHubPublicationReviewTarget({
        target,
        identity: await prepareCurrentGitHubPublicationIdentity("main"),
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("identity could not be verified");
  });
  it.each([
    "pushRepositoryId",
    "repositoryId",
    "baseCommit",
    "branch",
    "remoteHeadCommit",
  ] as const)("rejects a changed %s", (field) => {
    expect(() =>
      assertGitHubPublicationReviewedTarget(reviewed, {
        ...reviewed,
        [field]: field.endsWith("Id") ? 1003 : "c".repeat(40),
      }),
    ).toThrow("target or branch changed");
  });
  it("allows observation of its own accepted pushed head without accepting an unrelated one", () => {
    const own = "d".repeat(40);
    expect(() =>
      assertGitHubPublicationReviewedTarget(reviewed, { ...reviewed, remoteHeadCommit: own }, own),
    ).not.toThrow();
    expect(() =>
      assertGitHubPublicationReviewedTarget(
        reviewed,
        { ...reviewed, remoteHeadCommit: "e".repeat(40) },
        own,
      ),
    ).toThrow();
  });
});
