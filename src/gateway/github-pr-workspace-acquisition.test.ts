// Install the synthetic GitHub transport before loading the registered action owners.
// oxfmt-ignore
import { fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { gitHubPublicApi } from "./github-public-api.js";
import {
  commandResult,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";

describe("PR source acquisition", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["known", "retained", "unrelated", "inaccessible"] as const)(
    "avoids a cold fork fetch only for an accessible matching project (%s)",
    async (kind) => {
      const f = await fixture({ empty: true, fork: true });
      const repository = kind === "unrelated" ? "unrelated/repo" : f.pr.base.repo.full_name;
      await f.local!.git(
        "-C",
        f.upstream,
        "remote",
        "set-url",
        "origin",
        `https://github.com/${repository}.git`,
      );
      const project = await registerProjectRegistry({ path: f.upstream });
      if (kind === "retained") {
        await f.git(
          "fetch",
          "--no-write-fetch-head",
          f.upstream,
          `${f.headCommit}:refs/openclaw/fetched/${f.headCommit}`,
        );
      }
      if (kind === "inaccessible") {
        vi.spyOn(gitHubPublicApi, "fetchGitHubJson").mockResolvedValue({ visibility: "private" });
      }
      const head = await f.git("rev-parse", "HEAD");
      const commandsBefore = mocks.runCommand.mock.calls.length;
      const operation = f.invoke({}, f.sandbox, undefined, {
        requester: kind === "inaccessible" ? "guest" : "maintainer",
      });
      if (kind === "known") {
        await expect(operation).rejects.toThrow(`Start a new session using project ${project.id}`);
        expect(await f.git("rev-parse", "HEAD")).toBe(head);
        expect(f.readSession().worktree?.githubPullRequest).toBeUndefined();
        expect(
          mocks.runCommand.mock.calls
            .slice(commandsBefore)
            .some(([argv]) => argv.includes("fetch")),
        ).toBe(false);
      } else {
        await expect(operation).resolves.toMatchObject({
          status: "prepared",
          headCommit: f.headCommit,
        });
      }
    },
  );

  it.each([
    ["timeout", "Git commit fetch failed (timed out after 60 seconds; signal SIGTERM)"],
    ["command", "Git commit fetch failed: spawn git ENOENT"],
    [
      "inventory",
      "Git content inventory failed (exit code 128): fatal: unreadable object database",
    ],
    ["content fetch", "Git content fetch failed (exit code 128): fatal: unavailable object"],
    ["incomplete", "Git content verification failed: required objects are still missing"],
  ])("preserves the acquisition failure reason and workspace (%s)", async (failure, expected) => {
    const f = await fixture();
    const state = async () => ({
      hostHead: await f.git("rev-parse", "HEAD"),
      hostIndex: await f.git("write-tree"),
      guestHead: await f.guestGit("rev-parse", "HEAD"),
      guestIndex: await f.guestGit("write-tree"),
    });
    const before = await state();
    const transport = mocks.runCommand.getMockImplementation()!;
    const failed = (stderr: string) => ({
      ...commandResult("private repository output", 128),
      termination: "exit",
      stderr: Buffer.from(stderr),
    });
    mocks.runCommand.mockImplementation(async (argv: string[], options) => {
      if (argv.includes("fetch")) {
        if (failure === "timeout") {
          return { ...failed(""), code: null, termination: "timeout", signal: "SIGTERM" };
        }
        if (failure === "command") {
          return {
            ...failed(""),
            code: null,
            termination: "error",
            error: new Error(
              "spawn git ENOENT https://example.test/git?unknown=fixture-cause-secret",
            ),
          };
        }
        if (argv.includes("--stdin")) {
          return failure === "content fetch"
            ? failed("fatal: unavailable object")
            : commandResult();
        }
      }
      if (argv.includes("--missing=print")) {
        return failure === "inventory"
          ? failed("fatal: unreadable object database")
          : commandResult(`?${"f".repeat(40)}\n`);
      }
      return await transport(argv, options);
    });
    const error = await f.invoke().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(expected);
    if (failure === "timeout") {
      expect(String(error)).toContain("Do not repeat the same full-history fetch");
      expect(String(error)).toContain("base project's workspace");
    }
    expect(String(error)).not.toMatch(
      /private repository output|fixture-cause-secret|example\.test/u,
    );
    expect(await state()).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });
});
