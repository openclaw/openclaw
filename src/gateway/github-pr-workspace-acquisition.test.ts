// Install synthetic GitHub I/O before loading the registered action owners.
// oxfmt-ignore
import { bindFixtureRuntime, fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { gitHubPublicApi } from "./github-public-api.js";
import * as sourceIntegration from "./github-publication-base-refresh.js";
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

  it.each([false, true])(
    "prepares cold PR history and current files without historical blobs (empty=%s)",
    async (empty) => {
      const f = await fixture({ empty, fork: true });
      const runtime = await bindFixtureRuntime(f);
      using _ = runtime.projection;
      const upstream = (...args: string[]) => f.local!.git("-C", f.upstream, ...args);
      await upstream("config", "uploadpack.allowFilter", "true");
      await f.advanceHead({ "pr.txt": "obsolete PR contents\n" });
      const historicalBlob = await upstream("rev-parse", "HEAD:pr.txt");
      const head = await f.advanceHead({ "pr.txt": "current PR contents\n" });
      // Advance the base after the selected project's local snapshot.
      await upstream("checkout", "main");
      for (const contents of ["obsolete base contents\n", "current base contents\n"]) {
        await fs.writeFile(path.join(f.upstream, "base-only.txt"), contents);
        await upstream("add", "base-only.txt");
        await upstream("commit", "-m", "Advance base");
      }
      const historicalBaseBlob = await upstream("rev-parse", "HEAD^:base-only.txt");
      f.pr.base.sha = await upstream("rev-parse", "HEAD");
      // Git stores filter defaults per URL; a fork must not share its base's URL.
      const baseUrl = `${pathToFileURL(f.upstream).href}/.`;
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(
        async (
          argv: string[],
          options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
        ) => {
          if (argv.includes("fetch")) {
            expect(
              runtime.isPaused(),
              "History and blob fetches must leave the guest running",
            ).toBe(false);
          }
          return await transport(
            argv.map((arg) => (arg === "https://github.com/openclaw/openclaw.git" ? baseUrl : arg)),
            options,
          );
        },
      );
      vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
      await expect(f.git("cat-file", "-e", head)).rejects.toThrow();
      await expect(f.git("cat-file", "-e", f.pr.base.sha)).rejects.toThrow();

      expect(await f.invoke()).toMatchObject({
        status: "prepared",
        headCommit: head,
        review: { mode: "local", base: f.commonAncestor },
      });
      expect(await f.git("rev-parse", "--is-shallow-repository")).toBe("false");
      expect(await f.git("rev-list", "--count", head)).toBe("4");
      expect(await f.git("write-tree")).toBe(await upstream("rev-parse", `${head}^{tree}`));
      expect(
        await f.git("rev-list", "--objects", "--missing=print", "--max-count=1", head),
      ).not.toContain("?");
      for (const blob of [historicalBlob, historicalBaseBlob]) {
        await expect(f.git("cat-file", "-e", blob)).rejects.toThrow();
      }
      expect(await f.git("show", `${f.pr.base.sha}:base-only.txt`)).toBe("current base contents");
      expect(await fs.readFile(path.join(f.projection, "pr.txt"), "utf8")).toBe(
        "current PR contents\n",
      );

      const fetches = () => mocks.runCommand.mock.calls.filter(([argv]) => argv.includes("fetch"));
      const beforeRepeat = fetches().length;
      expect(await f.invoke()).toMatchObject({ status: "prepared", headCommit: head });
      expect(fetches()).toHaveLength(beforeRepeat);
      expect(f.writes).toEqual([]);
    },
  );

  it.each(["download", "verification"])(
    "preserves guest index edits made during PR source %s",
    async (phase) => {
      const f = await fixture({ empty: true, fork: true });
      const guestShell = f.sandbox.backend!.runShellCommand.bind(f.sandbox.backend);
      const runtime = await bindFixtureRuntime(f);
      using _ = runtime.projection;
      const transport = mocks.runCommand.getMockImplementation()!;
      let edited = false;
      const edit = async () => {
        if (!edited) {
          expect(runtime.isPaused()).toBe(false);
          edited = true;
          // Simulate an already-running guest writer, independent of new-command admission.
          await fs.writeFile(path.join(f.projection, "notes.txt"), "guest staged work\n");
          expect((await guestShell({ script: "git add -- notes.txt" })).code).toBe(0);
          await fs.rm(path.join(f.projection, "notes.txt"));
        }
      };
      mocks.runCommand.mockImplementation(async (argv: string[], options) => {
        if (phase === "download" && argv.includes("fetch")) {
          await edit();
        }
        return await transport(argv, options);
      });
      const integrate = sourceIntegration.integrateManagedWorkspaceSource;
      using integration = vi.spyOn(sourceIntegration, "integrateManagedWorkspaceSource");
      integration.mockImplementation((params) => {
        const source = params.source!;
        return integrate({
          ...params,
          source: {
            ...source,
            verify: async () => {
              await source.verify();
              if (phase === "verification") {
                await edit();
              }
            },
          },
        });
      });
      await expect(f.invoke()).rejects.toThrow("existing dirty, untracked, or unpublished work");
      expect(edited).toBe(true);
      expect(runtime.isPaused()).toBe(false);
      expect(await f.guestGit("show", ":notes.txt")).toBe("guest staged work");
      await expect(fs.stat(path.join(f.projection, "pr.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.writes).toEqual([]);
      expect(f.externalWrites).toEqual([]);
    },
  );

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
