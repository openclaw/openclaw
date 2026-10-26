import { execFileSync, execSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withGitHubNegativeControl as negativeControl } from "./github-network-guard.mjs";
import { requireNodeTool } from "./node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = requireNodeTool("node");
const forbidden = "GitHub network access is forbidden in ordinary tests";

function localGitSsh(directory: string, source: string, service = "upload-pack") {
  const ssh = join(directory, "ssh.mjs");
  writeFileSync(
    ssh,
    `#!${node}\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync("git", [${JSON.stringify(service)}, ${JSON.stringify(source)}], { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
  );
  chmodSync(ssh, 0o755);
  return { ...process.env, GIT_SSH: ssh, GIT_SSH_VARIANT: "simple" };
}

function commitGitFixture(directory: string, text: string) {
  writeFileSync(join(directory, "README"), text);
  execFileSync("git", ["-C", directory, "add", "README"]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

describe("ordinary Git transport admission", () => {
  it("allows local Git metadata containing a GitHub remote URL", () => {
    const directory = tempDirs.make("github-git-metadata-");
    execFileSync("git", ["init", "-q", directory]);
    const remote = "https://github.com/example/repo.git";
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: directory });
    expect(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
    ).toBe(remote);
    execFileSync("git", ["config", "fixture.operation", "fetch"], { cwd: directory });
    expect(
      execFileSync("git", ["config", "fixture.operation"], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
    ).toBe("fetch");
  });

  it.each([["fetch", "origin"], ["fetch"], ["remote", "update"]])(
    "resolves configured GitHub-to-local rewrites for git %s",
    (...args) => {
      const directory = tempDirs.make("github-git-remote-guard-");
      const source = join(directory, "source.git");
      const checkout = join(directory, "checkout");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", checkout]);
      const remote = "https://github.com/example/repo.git";
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
      // The baseline reaches only this local repository, even without the guard.
      execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: checkout });
      expect(spawnSync("git", args, { cwd: checkout }).status).toBe(0);
      execFileSync("git", ["remote", "set-url", "origin", "git@github.com:example/repo.git"], {
        cwd: checkout,
      });
      expect(() =>
        negativeControl(() =>
          execFileSync("git", args, { cwd: checkout, env: localGitSsh(directory, source) }),
        ),
      ).toThrow(forbidden);
    },
  );

  it("allows an explicitly nonrecursive local push while blocking recursion and GitHub destinations", () => {
    const directory = tempDirs.make("github-local-push-guard-");
    const source = join(directory, "source.git");
    const checkout = join(directory, "checkout");
    execFileSync("git", ["init", "--bare", "-q", source]);
    execFileSync("git", ["init", "-q", checkout]);
    const sha = commitGitFixture(checkout, "synthetic local push\n");
    const push = ["push", "--recurse-submodules=no", source, "HEAD:refs/heads/main"];
    expect(spawnSync("git", push, { cwd: checkout }).status).toBe(0);
    expect(
      execFileSync("git", ["-C", source, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(sha);
    expect(() =>
      negativeControl(() =>
        execFileSync(
          "git",
          ["push", "--recurse-submodules=on-demand", source, "HEAD:refs/heads/main"],
          { cwd: checkout },
        ),
      ),
    ).toThrow(forbidden);
    const remote = "https://github.com/example/repo.git";
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
    // Even without admission this destination resolves only to the local bare fixture.
    execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: checkout });
    expect(
      spawnSync("git", ["push", "--recurse-submodules=no", "origin", "HEAD:refs/heads/main"], {
        cwd: checkout,
      }).status,
    ).toBe(0);
    execFileSync("git", ["remote", "add", "unrelated", "git@github.com:unrelated/repo.git"], {
      cwd: checkout,
    });
    expect(spawnSync("git", push, { cwd: checkout }).status).toBe(0);
    expect(
      spawnSync("git", ["maintenance", "run", "--auto", "--quiet", "--detach"], { cwd: checkout })
        .status,
    ).toBe(0);
    expect(() =>
      negativeControl(() =>
        execFileSync("git", ["maintenance", "run", "--task=prefetch"], { cwd: checkout }),
      ),
    ).toThrow(forbidden);
  });

  it("resolves a local rewrite when remote creation immediately fetches", () => {
    const directory = tempDirs.make("github-git-remote-create-");
    const source = join(directory, "source.git");
    execFileSync("git", ["init", "--bare", "-q", source]);
    execFileSync("git", ["init", "-q", directory]);
    const remote = "https://github.com/example/repo.git";
    execFileSync("git", ["config", `url.${source}.insteadOf`, remote], { cwd: directory });
    expect(
      spawnSync("git", ["remote", "add", "-f", "origin", remote], { cwd: directory }).status,
    ).toBe(0);
  });

  it
    .skipIf(process.platform === "win32")
    .each(["github.com:example/repo.git", "fixture@github.com:example/repo.git"])(
    "blocks SCP-style Git destinations %s",
    (remote) => {
      const directory = tempDirs.make("github-scp-git-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      // The baseline SSH request is served locally and never opens a socket.
      expect(() =>
        negativeControl(() =>
          execFileSync("git", ["ls-remote", remote], {
            cwd: directory,
            env: localGitSsh(directory, source),
          }),
        ),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "checks URL rewrite bases without a trailing slash",
    () => {
      const directory = tempDirs.make("github-rewrite-base-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["config", "url.ssh://github.com.insteadOf", "fixture:"], {
        cwd: directory,
      });
      expect(() =>
        negativeControl(() =>
          execFileSync("git", ["ls-remote", "fixture:/example/repo.git"], {
            cwd: directory,
            env: localGitSsh(directory, source),
          }),
        ),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32").each(["fetch-pack", "send-pack"])(
    "blocks native Git transport plumbing %s",
    (operation) => {
      const directory = tempDirs.make("github-git-plumbing-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      expect(() =>
        negativeControl(() =>
          execFileSync("git", [operation, "--all", "git@github.com:example/repo.git"], {
            cwd: directory,
            env: localGitSsh(
              directory,
              source,
              operation === "send-pack" ? "receive-pack" : "upload-pack",
            ),
          }),
        ),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32").each(["quoted directory", "changed directory"])(
    "blocks shell Git network operations with a %s",
    (mode) => {
      const directory = tempDirs.make("github-shell-git-guard-");
      const source = join(directory, "source.git");
      const checkout = join(directory, "checkout repo");
      execFileSync("git", ["init", "--bare", "-q", source]);
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["init", "-q", checkout]);
      const remote = "git@github.com:example/repo.git";
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
      const quoted = `'${checkout.replaceAll("'", "'\\''")}'`;
      const prefix = mode === "quoted directory" ? `git -C ${quoted}` : `cd ${quoted} && git`;
      expect(() =>
        negativeControl(() =>
          execSync(`${prefix} fetch origin`, {
            cwd: directory,
            env: localGitSsh(directory, source),
          }),
        ),
      ).toThrow(forbidden);
      expect(
        execSync(`${prefix} rev-parse --git-dir`, { cwd: directory, encoding: "utf8" }).trim(),
      ).toBe(".git");
    },
  );

  it.each(["--recurse-submodules", "--recurse-submodules=component", "--recurse-submodules=no"])(
    "rejects recursive clone admission with %s",
    (option) => {
      const directory = tempDirs.make("github-recursive-clone-guard-");
      const source = join(directory, "source.git");
      execFileSync("git", ["init", "--bare", "-q", source]);
      // This source is empty and local, so the pre-fix probe cannot contact GitHub.
      expect(() =>
        negativeControl(() =>
          execFileSync("git", ["clone", option, source, join(directory, "checkout")], {
            cwd: directory,
          }),
        ),
      ).toThrow(forbidden);
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["uninitialized update", "populated update", "populated fetch"])(
    "blocks GitHub submodules during %s",
    (mode) => {
      const directory = tempDirs.make("github-submodule-guard-");
      const source = join(directory, "source");
      const checkout = join(directory, "checkout");
      execFileSync("git", ["init", "-q", source]);
      execFileSync("git", ["init", "-q", checkout]);
      const sha = commitGitFixture(source, "synthetic fixture\n");
      const populated = mode.startsWith("populated");
      writeFileSync(
        join(checkout, ".gitmodules"),
        `[submodule "component"]\npath = component\nurl = ${populated ? source : "git@github.com:example/repo.git"}\n`,
      );
      if (populated) {
        const component = join(checkout, "component");
        const modules = join(checkout, ".git", "modules");
        mkdirSync(modules, { recursive: true });
        execFileSync("git", [
          "init",
          "-q",
          "--separate-git-dir",
          join(modules, "component"),
          component,
        ]);
        execFileSync("git", [
          "-C",
          component,
          "remote",
          "add",
          "origin",
          "git@github.com:example/repo.git",
        ]);
        commitGitFixture(component, "initial component fixture\n");
      }
      execFileSync("git", ["-C", checkout, "add", ".gitmodules"]);
      execFileSync("git", [
        "-C",
        checkout,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${sha},component`,
      ]);
      // The pre-fix clone is served locally; this SSH fixture never opens a socket.
      expect(() =>
        negativeControl(() =>
          execFileSync(
            "git",
            mode.endsWith("fetch") ? ["fetch", source] : ["submodule", "update", "--init"],
            {
              cwd: checkout,
              env: localGitSsh(directory, source),
            },
          ),
        ),
      ).toThrow(forbidden);
    },
  );
});
