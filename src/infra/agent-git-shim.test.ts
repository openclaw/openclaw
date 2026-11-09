import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createExecTool } from "../agents/bash-tools.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
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
  "keeps agent probes local while hydrating history and allowing negotiated recovery",
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
    }),
);
