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
import { AGENT_GIT_SHIM } from "./agent-git-shim.js";
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
  "negotiates missing revision roots before shared-clone content commands",
  () =>
    withTempDir("agent-git-commits-", async (root) => {
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
      const seed = path.join(root, "seed");
      const originUrl = pathToFileURL(origin).href;
      git(root, "init", "--initial-branch=main", origin);
      git(origin, "config", "uploadpack.allowFilter", "true");
      await fs.writeFile(path.join(origin, "file.txt"), "base content\n");
      git(origin, "add", ".");
      git(origin, "commit", "-m", "base");
      for (let index = 0; index < 12; index++) {
        git(origin, "commit", "--allow-empty", "-m", `history ${index}`);
      }
      const base = git(origin, "rev-parse", "HEAD");
      git(root, "clone", "--depth=1", "--filter=blob:none", "--no-checkout", originUrl, seed);
      git(seed, "fetch", "--unshallow", "origin");
      expect(git(seed, "rev-parse", "--is-shallow-repository")).toBe("false");
      await fs.writeFile(path.join(origin, "file.txt"), "remote content\n");
      git(origin, "commit", "-am", "remote change");
      const missing = git(origin, "rev-parse", "HEAD");
      const shim = path.join(root, "git");
      await fs.writeFile(shim, AGENT_GIT_SHIM, { mode: 0o755 });
      const packedObjects = (cwd: string) =>
        Number(git(cwd, "count-objects", "-v").match(/in-pack: (\d+)/)?.[1]);
      const cases: [string, ...string[]][] = [
        ["show", `${missing}:file.txt`],
        ["show", "--cc", `${missing}:file.txt`],
        ["rev-list", "--header", missing, "--max-count=1"],
        ["show", "-U", missing],
        ["show", "-m", `${missing}:file.txt`],
        ["show", "--pretty", `${missing}:file.txt`],
        ["diff", `${base}..${missing}`, "--", "file.txt"],
        ["diff", `${base}...${missing}`, "--", "file.txt"],
        ["diff", "-b", missing, base],
        ["log", "-1", "--format=%H", `${missing}~1`],
        ["blame", "-n", missing, "--", "file.txt"],
        ["ls-tree", "--name-only", missing],
        ["format-patch", "-1", "--stdout", missing],
        ["cat-file", "-p", missing],
        ["restore", `--source=${missing}`, "--", "file.txt"],
        ["restore", "--source", missing, "--", "file.txt"],
        ["checkout", "--detach", missing],
        ["cherry-pick", "--no-commit", "-s", missing],
        ["cherry-pick", "-S", missing, "--no-gpg-sign", "--no-commit"],
        ["merge-base", base, missing],
        ["show", "refs/heads/remote-tip:file.txt"],
      ];
      for (const [index, args] of cases.entries()) {
        const clone = path.join(root, `clone-${index}`);
        const linked = path.join(root, `linked ${index}`);
        await fs.cp(seed, clone, { recursive: true });
        git(clone, "worktree", "add", "--detach", linked);
        if (args.includes("refs/heads/remote-tip:file.txt")) {
          await fs.writeFile(path.join(clone, ".git/refs/heads/remote-tip"), `${missing}\n`);
        }
        // Both repository selection and command-local transport configuration must survive prefetch.
        git(clone, "config", "protocol.file.allow", "never");
        const before = packedObjects(clone);
        const packet = path.join(root, `packet-${index}`);
        const result = spawnSync(
          shim,
          ["-C", root, "-C", path.basename(linked), "-c", "protocol.file.allow=always", ...args],
          {
            env: { ...env, GIT_ALLOW_PROTOCOL: undefined, GIT_TRACE_PACKET: packet },
            encoding: "utf8",
          },
        );
        expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
        expect(packedObjects(clone) - before, args.join(" ")).toBeLessThanOrEqual(4);
        expect(await fs.readFile(packet, "utf8"), args.join(" ")).toMatch(/fetch> have /);
        if (["show", "diff", "blame", "format-patch"].includes(args[0])) {
          expect(result.stdout).toContain("remote content");
        } else if (["restore", "checkout", "cherry-pick"].includes(args[0])) {
          expect(await fs.readFile(path.join(linked, "file.txt"), "utf8")).toBe("remote content\n");
        } else if (args[0] === "ls-tree") {
          expect(result.stdout.trim()).toBe("file.txt");
        } else if (["log", "merge-base"].includes(args[0])) {
          expect(result.stdout.trim()).toBe(base);
        } else {
          expect(result.stdout).toContain("remote change");
        }
      }
      const linked = path.join(root, "negative");
      git(seed, "worktree", "add", "--detach", linked);
      const packet = path.join(root, "negative.packet");
      const invoke = (...args: string[]) =>
        spawnSync(shim, ["-C", linked, ...args], {
          env: { ...env, GIT_TRACE_PACKET: packet },
          encoding: "utf8",
        });
      for (const args of [
        ["log", "-1", `--format=format:${missing}`, "HEAD"],
        ["log", "-1", "--grep", missing, "HEAD"],
        ["log", "--find-object", "a".repeat(40), "HEAD"],
        ["diff", "--", missing],
      ]) {
        const result = invoke(...args);
        expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      }
      expect(invoke("--no-lazy-fetch", "show", `${missing}:file.txt`).status).not.toBe(0);
      expect(invoke("show", "unresolvable-name:file.txt").status).not.toBe(0);
      await expect(fs.stat(packet)).rejects.toMatchObject({ code: "ENOENT" });
      const blob = git(origin, "rev-parse", "HEAD:file.txt");
      expect(invoke("cat-file", "-p", blob).stdout).toBe("remote content\n");
      await fs.writeFile(packet, "");
      expect(invoke("cat-file", "-p", blob).stdout).toBe("remote content\n");
      expect(invoke("cat-file", "-p", `${base}^{tree}`).status).toBe(0);
      expect(await fs.readFile(packet, "utf8")).toBe("");
      const rejected = invoke("show", `${"a".repeat(40)}:file.txt`);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("OpenClaw:");
      expect((await fs.readFile(packet, "utf8")).match(/fetch> want /g)).toHaveLength(1);
    }),
);

it.skipIf(process.platform === "win32")(
  "keeps probes local, bounds projection fetches, and preserves shared worktree history",
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
      for (let index = 0; index < 80; index++) {
        git(origin, "commit", "--allow-empty", "-m", `old history ${index}`);
      }
      git(root, "clone", origin, fork);
      git(origin, "commit", "--allow-empty", "-m", "base advanced past fork point");
      const projectionBase = git(origin, "rev-parse", "HEAD");
      git(fork, "checkout", "-b", "contributor-pr");
      git(fork, "config", "uploadpack.allowFilter", "true");
      git(origin, "config", "remote.origin.url", "https://github.com/fixture/base.git");
      await prepareLocalWorkspaceCheckout({
        source: origin,
        destination: projection,
        temporaryRoot: root,
        baseCommit: projectionBase,
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
      git(projection, "config", `url.${pathToFileURL(fork).href}.insteadOf`, forkUrl);
      git(projection, "config", "remote.origin.url", forkUrl);
      expect((await command(["fetch", "--prune"], projection)).exitCode).toBe(0);
      expect(objects().filter((type) => type === "commit").length).toBeLessThanOrEqual(65);
      expect(objects().filter((type) => type === "blob")).toHaveLength(blobs);
      git(projection, "config", "remote.origin.url", "https://github.com/fixture/base.git");
      for (const url of [
        forkUrl,
        "git@github.com:fixture/contributor.git",
        "ssh://git@github.com/fixture/contributor.git",
      ]) {
        if (url !== forkUrl) {
          git(projection, "config", "--add", `url.${pathToFileURL(fork).href}.insteadOf`, url);
        }
        expect(
          (
            await command(
              [
                "-C",
                projection,
                "fetch",
                "--filter=blob:none",
                "--refetch",
                "--",
                url,
                "contributor-pr",
              ],
              root,
            )
          ).exitCode,
        ).toBe(0);
        expect(objects().filter((type) => type === "blob")).toHaveLength(blobs);
        expect(objects().filter((type) => type === "commit").length).toBeLessThanOrEqual(65);
        expect(git(projection, "log", "-2", "--format=%s", `${projectionBase}..FETCH_HEAD`)).toBe(
          "current fork content\nobsolete fork content",
        );
        expect(git(projection, "config", "--get", `remote.${url}.promisor`)).toBe("true");
      }
      const forkHead = git(projection, "rev-parse", "FETCH_HEAD");
      expect((await command(["fetch", "origin", "main"], projection)).exitCode).toBe(0);
      expect(git(projection, "log", "--format=%s", `${projectionBase}..${forkHead}`)).toBe(
        "current fork content\nobsolete fork content",
      );
      expect((await command(["diff", projectionBase, forkHead], projection)).aggregated).toContain(
        "current fork content",
      );
      expect((await command(["checkout", "--detach", forkHead], projection)).exitCode).toBe(0);
      expect(await fs.readFile(path.join(projection, "fork.txt"), "utf8")).toBe(
        "current fork content",
      );
      expect(objects().filter((type) => type === "blob")).toHaveLength(blobs + 1);
      expect(
        (
          await command(
            ["fetch", "--refetch", "--no-filter", "--depth=128", forkUrl, "contributor-pr"],
            projection,
          )
        ).exitCode,
      ).toBe(0);
      expect(objects().filter((type) => type === "blob").length).toBeGreaterThan(blobs + 1);
      expect(Number(git(projection, "rev-list", "--count", "FETCH_HEAD"))).toBeGreaterThan(64);
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
      expect((await command(["fetch", forkUrl, "contributor-pr"], linked)).exitCode).toBe(0);
      expect(await fs.readFile(shallow, "utf8")).toBe(boundary);
      expect(Number(git(linked, "rev-list", "--count", "FETCH_HEAD"))).toBeGreaterThan(64);
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
          ["2", "3", "85", "84", "85", "1"][index],
        );
      }
    }),
);
