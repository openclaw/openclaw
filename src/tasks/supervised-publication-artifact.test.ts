import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requirePublicationCommand } from "../gateway/github-publication-git-transport.js";
import {
  prepareSupervisedPublicationArtifact,
  supervisedPublicationArtifactPath,
} from "./supervised-publication-artifact.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

const fixture = vi.hoisted(() => ({ remote: "" }));
vi.mock("../gateway/github-publication-git-transport.js", async (original) => {
  const actual = await original<typeof import("../gateway/github-publication-git-transport.js")>();
  return {
    ...actual,
    requirePublicationCommand: async (
      args: string[],
      options: Parameters<typeof actual.requirePublicationCommand>[1],
    ) => {
      // Exercise real Git objects without remote credentials or a private signing
      // key. Live contract proof separately checks GitHub signature verification.
      const local = args.map((arg) =>
        arg.startsWith("https://github.com/") ? fixture.remote : arg,
      );
      return actual.requirePublicationCommand(
        local.filter((arg) => !arg.startsWith("-S")),
        options,
      );
    },
  };
});
const dirs = createTempDirTracker();
afterEach(() => dirs.cleanup());

it("freezes the accepted author and committer despite conflicting ambient identity", async () => {
  const root = dirs.make("publication-author-");
  const workspace = `${root}/workspace`;
  fixture.remote = `${root}/base.git`;
  await fs.mkdir(workspace);
  await fs.writeFile(`${workspace}/result.txt`, "accepted artifact\n");
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: "Ambient Author",
    GIT_AUTHOR_EMAIL: "ambient-author@example.test",
    GIT_COMMITTER_NAME: "Ambient Committer",
    GIT_COMMITTER_EMAIL: "ambient-committer@example.test",
  };
  const git = (args: string[]) =>
    requirePublicationCommand(["git", "--git-dir", fixture.remote, ...args], { env });
  await git(["init", "--bare", fixture.remote]);
  const baseTree = await git(["mktree"]);
  const baseCommit = await git(["commit-tree", baseTree, "-m", "Synthetic base"]);
  await git(["update-ref", "refs/heads/main", baseCommit]);
  const accepted = { name: "Accepted Author", email: "accepted@example.test" };
  const { contract } = encodeSupervisedWorkflowContract({
    version: 1,
    workspace,
    profiles: [
      {
        kind: "publication",
        id: "publish",
        repository: "synthetic/repo",
        pushRepository: "synthetic/repo",
        baseBranch: "main",
        baseCommit,
        branch: "proof",
        title: "Synthetic publication",
        body: "Fixture",
        timeoutMs: 60_000,
        publisher: {
          agentId: "fixture",
          accountId: 1,
          login: "synthetic",
          source: "system-detected",
          signingKey: "A".repeat(40),
          gitAuthor: accepted,
        },
      },
    ],
    acceptance: [{ kind: "receipts", criterionId: "published", profiles: ["publish"] }],
  });
  const profile = contract.profiles[0];
  if (profile?.kind !== "publication") {
    throw new Error("Missing publication profile");
  }
  const executionId = randomUUID();
  const options = { path: `${root}/state.sqlite` };
  const prepared = await prepareSupervisedPublicationArtifact({
    contract,
    profile,
    options,
    identity: { source: "system-detected", account: { accountId: 1, login: "synthetic" }, env },
    execution: {
      executionId,
      operationId: randomUUID(),
      generation: 1,
      ownerId: "fixture",
      leaseExpiresAt: 10000,
      startedAt: 1,
      dispatchedAt: null,
      finishedAt: null,
      process: null,
      outcome: null,
      preparationError: null,
    },
    assertCurrent: () => {},
  });
  const artifact = supervisedPublicationArtifactPath(executionId, options);
  const metadata = await requirePublicationCommand(
    [
      "git",
      "--git-dir",
      artifact,
      "show",
      "-s",
      "--format=%an%n%ae%n%cn%n%ce",
      prepared.headCommit,
    ],
    { env },
  );
  expect(metadata.split("\n")).toEqual([
    accepted.name,
    accepted.email,
    accepted.name,
    accepted.email,
  ]);
  expect(
    await requirePublicationCommand(
      ["git", "--git-dir", artifact, "show", `${prepared.headCommit}:result.txt`],
      { env },
    ),
  ).toBe("accepted artifact");
});
