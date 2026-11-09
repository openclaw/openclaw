import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createExecTool } from "../agents/bash-tools.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { prepareLocalWorkspaceCheckout } from "../gateway/worker-environments/local-workspace-checkout.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createSourceCliFixture,
  withSourceCliParent,
} from "./openclaw-cli-invocation.test-support.js";
import {
  clearGatewayAgentCliShim,
  mergeGatewayAgentCliPath,
  prepareGatewayAgentCliShim,
} from "./openclaw-cli-shim.js";

afterEach(clearGatewayAgentCliShim);

it.skipIf(process.platform === "win32")(
  "keeps probes local and hydrates origin and fork history after filtered fetches",
  () =>
    withTempDir("agent-git-probes-", async (root) => {
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_ALLOW_PROTOCOL: "file",
      };
      const git = (cwd: string, ...args: string[]) => {
        const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const origin = path.join(root, "origin");
      const clone = path.join(root, "partial");
      git(root, "init", "--initial-branch=main", origin);
      git(origin, "config", "uploadpack.allowFilter", "true");
      await fs.writeFile(path.join(origin, "file.txt"), "old content\n");
      git(origin, "add", ".");
      git(origin, "commit", "-m", "old");
      const old = git(origin, "rev-parse", "HEAD");
      await fs.writeFile(path.join(origin, "file.txt"), "new content\n");
      git(origin, "commit", "-am", "new");
      git(root, "clone", "--filter=blob:none", "--no-checkout", pathToFileURL(origin).href, clone);
      git(origin, "commit", "--allow-empty", "-m", "remote only");
      const missing = git(origin, "rev-parse", "HEAD");
      const fixture = await createSourceCliFixture(root);
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, () =>
        withSourceCliParent(fixture, prepareGatewayAgentCliShim),
      );
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: clone,
        pathPrepend: mergeGatewayAgentCliPath(),
        notifyOnExit: false,
        allowBackground: false,
      });
      const trace = path.join(root, "probe.trace");
      const command = async (args: string[], workdir = clone) => {
        const result = await tool.execute("git-probe", {
          command: `GIT_TRACE=${quoteCliArg(trace)} git -c protocol.file.allow=always ${args.map(quoteCliArg).join(" ")}`,
          workdir,
          yieldMs: 120_000,
        });
        const details = result.details;
        if (details.status !== "completed" && details.status !== "failed") {
          throw new Error(`Expected a settled Git command, got ${details.status}`);
        }
        return details;
      };
      const config = await fs.readFile(path.join(clone, ".git/config"), "utf8");
      const packs = await fs.readdir(path.join(clone, ".git/objects/pack"));
      for (const args of [
        ["cat-file", "-t", missing],
        ["--no-pager", "-C", clone, "cat-file", "-e", missing],
        ["rev-parse", "--verify", "--quiet", `${missing}^{commit}`],
        ["merge-base", "--is-ancestor", missing, "HEAD"],
      ]) {
        const result = await command(args);
        expect(result.exitCode).not.toBe(0);
        expect(result.aggregated).toContain("--negotiation-tip=origin/main");
      }
      expect(await fs.readdir(path.join(clone, ".git/objects/pack"))).toEqual(packs);
      expect(await fs.readFile(trace, "utf8")).not.toContain("fetch origin");
      expect((await command(["cat-file", "-t", "HEAD"])).aggregated).toBe("commit");
      const negative = await command(["merge-base", "--is-ancestor", "HEAD", old]);
      expect(negative.exitCode).toBe(1);
      expect(negative.aggregated).not.toContain("OpenClaw:");
      for (const [index, args] of [
        ["show", `${old}:file.txt`],
        ["log", "-p", "-1", "HEAD~1"],
        ["blame", "HEAD", "--", "file.txt"],
        ["diff", old, "HEAD", "--", "file.txt"],
      ].entries()) {
        const history = path.join(root, `history-${index}`);
        git(
          root,
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          pathToFileURL(origin).href,
          history,
        );
        expect((await command(args, history)).exitCode).toBe(0);
      }
      expect(
        (await command(["fetch", "origin", missing, "--negotiation-tip=origin/main"])).exitCode,
      ).toBe(0);
      expect((await command(["cat-file", "-t", missing])).aggregated).toBe("commit");
      expect(await fs.readFile(path.join(clone, ".git/config"), "utf8")).toBe(config);
      // A fork can contain blobs that the projection's origin cannot hydrate.
      const fork = path.join(root, "fork");
      const projection = path.join(root, "projection");
      const forkUrl = "https://github.com/fixture/contributor.git";
      git(root, "clone", origin, fork);
      git(fork, "checkout", "-b", "contributor-pr");
      git(fork, "config", "uploadpack.allowFilter", "true");
      git(origin, "config", "remote.origin.url", "https://github.com/fixture/base.git");
      await prepareLocalWorkspaceCheckout({
        source: origin,
        destination: projection,
        temporaryRoot: root,
        baseCommit: missing,
        branch: "projection",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      git(
        projection,
        "config",
        `url.${pathToFileURL(origin).href}.insteadOf`,
        "https://github.com/fixture/base.git",
      );
      for (const content of ["obsolete fork content", "current fork content"]) {
        await fs.writeFile(path.join(fork, "fork.txt"), content);
        git(fork, "add", ".");
        git(fork, "commit", "-m", content);
      }
      const objects = () =>
        git(projection, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)").split(
          "\n",
        );
      const blobs = objects().filter((type) => type === "blob").length;
      for (const url of [
        forkUrl,
        "git@github.com:fixture/contributor.git",
        "ssh://git@github.com/fixture/contributor.git",
      ]) {
        git(projection, "config", "--add", `url.${pathToFileURL(fork).href}.insteadOf`, url);
        expect(
          (
            await command(
              ["-C", projection, "fetch", "--refetch", "--", url, "contributor-pr"],
              root,
            )
          ).exitCode,
        ).toBe(0);
        expect(objects().filter((type) => type === "blob")).toHaveLength(blobs);
        expect(git(projection, "config", "--get", `remote.${url}.promisor`)).toBe("true");
      }
      expect((await command(["diff", "HEAD", "FETCH_HEAD"], projection)).aggregated).toContain(
        "current fork content",
      );
      expect((await command(["checkout", "--detach", "FETCH_HEAD"], projection)).exitCode).toBe(0);
      expect(await fs.readFile(path.join(projection, "fork.txt"), "utf8")).toBe(
        "current fork content",
      );
      expect(objects().filter((type) => type === "blob")).toHaveLength(blobs + 1);
      expect(
        (
          await command(
            ["fetch", "--refetch", "--no-filter", forkUrl, "contributor-pr"],
            projection,
          )
        ).exitCode,
      ).toBe(0);
      expect(objects().filter((type) => type === "blob").length).toBeGreaterThan(blobs + 1);
      git(fork, "config", `url.${pathToFileURL(fork).href}.insteadOf`, forkUrl);
      expect((await command(["fetch", forkUrl, "contributor-pr"], fork)).exitCode).toBe(0);
      expect(git(fork, "config", "--local", "--list")).not.toContain("promisor");
      // Linked worktrees share shallow boundaries, but sandbox projections do not.
      git(origin, "tag", "cutoff", old);
      const shared = path.join(root, "shared base");
      const linked = path.join(root, "linked worktree");
      git(root, "clone", "--filter=blob:none", "--depth=1", pathToFileURL(origin).href, shared);
      git(shared, "worktree", "add", "--detach", linked);
      const shallow = path.join(shared, ".git/shallow");
      const boundary = await fs.readFile(shallow, "utf8");
      const sharedPacks = await fs.readdir(path.join(shared, ".git/objects/pack"));
      const shallowFlags = [
        ["--depth=2"],
        ["--deepen", "2"],
        ["--shallow-since=2000-01-01"],
        ["--shallow-exclude=cutoff"],
        ["--unshallow"],
        ["--update-shallow"],
      ];
      await fs.writeFile(trace, "");
      for (const verb of ["fetch", "pull"]) {
        for (const flags of shallowFlags) {
          const result = await command([
            "-C",
            root,
            "-C",
            "linked worktree",
            verb,
            ...(verb === "fetch" ? ["--filter=blob:none"] : []),
            ...flags,
            "origin",
            "main",
          ]);
          expect(await fs.readFile(shallow, "utf8")).toBe(boundary);
          expect(result.exitCode).toBe(2);
          expect(result.aggregated).toContain("gh api repos/<owner>/<repo>/commits/<sha>");
          expect(result.aggregated).toContain("compare/<base>...<head>");
        }
      }
      git(shared, "config", `url.${pathToFileURL(fork).href}.insteadOf`, forkUrl);
      expect(
        (await command(["fetch", "--depth=1", forkUrl, "contributor-pr"], linked)).exitCode,
      ).toBe(2);
      // The primary checkout shares the same boundary too, including via --git-dir.
      expect(
        (await command([`--git-dir=${shared}/.git`, "fetch", "--depth", "2", "origin", "main"]))
          .exitCode,
      ).toBe(2);
      expect(await fs.readFile(shallow, "utf8")).toBe(boundary);
      expect(await fs.readdir(path.join(shared, ".git/objects/pack"))).toEqual(sharedPacks);
      expect(await fs.readFile(trace, "utf8")).not.toContain("upload-pack");
      // Ordinary fetch gets new tips without deepening; API/Doctor guidance is necessary.
      git(origin, "commit", "--allow-empty", "-m", "next tip");
      const next = git(origin, "rev-parse", "HEAD");
      expect((await command(["fetch", "origin", "main"], linked)).exitCode).toBe(0);
      expect(git(linked, "rev-parse", "origin/main")).toBe(next);
      expect(git(linked, "rev-list", "--count", "origin/main")).toBe("2");
      expect(await fs.readFile(shallow, "utf8")).toBe(boundary);
      // The maintenance owner can unshallow; agent log then sees the requested history.
      git(shared, "fetch", "--unshallow", "origin", "main");
      expect((await command(["log", "--format=%H", "origin/main"], linked)).aggregated).toContain(
        old,
      );
      expect((await command(["fetch", "--depth=1", "origin", "main"], linked)).exitCode).toBe(2);
      expect((await command(["pull", "--deepen=2", "origin", "main"], shared)).exitCode).toBe(2);
      await expect(fs.stat(shallow)).rejects.toMatchObject({ code: "ENOENT" });
      for (const [index, flags] of shallowFlags.entries()) {
        const standalone = path.join(root, `standalone-${index}`);
        git(
          root,
          "clone",
          "--filter=blob:none",
          "--depth=1",
          pathToFileURL(origin).href,
          standalone,
        );
        const result = await command(
          [index % 2 ? "pull" : "fetch", "--ff-only", ...flags, "origin", "main"].filter(
            (arg) => index % 2 || arg !== "--ff-only",
          ),
          standalone,
        );
        expect(result.exitCode, result.aggregated).toBe(0);
        expect(result.aggregated).not.toContain("OpenClaw:");
        expect(git(standalone, "rev-list", "--count", "HEAD")).toBe(
          ["2", "3", "4", "3", "4", "1"][index],
        );
      }
    }),
);
