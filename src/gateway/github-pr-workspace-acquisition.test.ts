// Install synthetic GitHub I/O before loading the registered action owners.
// oxfmt-ignore
import { bindFixtureRuntime, fixture, mocks } from "./github-pr-workspace-preparation.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as sourceIntegration from "./github-publication-base-refresh.js";
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";

describe("GitHub source acquisition with a running guest", () => {
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
});
