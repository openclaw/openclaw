import { execFileSync, spawnSync as spawnGit, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePrepareGitHooks } from "../../scripts/prepare-git-hooks.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type SpawnResult = Partial<Pick<ReturnType<typeof spawnGit>, "error" | "status">> & {
  stderr?: string;
  stdout?: string;
};

function configure(results: SpawnResult[], hooks = true, cwd = "/repo") {
  const warn = vi.fn();
  const spawnSync = vi.fn((_bin: string, _args: string[]) => {
    const result = results.shift();
    if (!result) {
      throw new Error("unexpected git invocation");
    }
    return result;
  });
  const result = configurePrepareGitHooks({ cwd, existsSync: () => hooks, spawnSync, warn });
  return { result, warn, spawnSync };
}

describe("configurePrepareGitHooks", () => {
  it.each([0, 1])("stays quiet when Git is unavailable at command %i", (command) => {
    const enoent = Object.assign(new Error("missing git"), { code: "ENOENT" });
    const preceding: SpawnResult[] = [{ status: 0, stdout: "true\n" }, { status: 1 }];
    const { result, warn } = configure(
      [...preceding.slice(0, command), { error: enoent }],
      true,
      "C:\\repo",
    );
    expect(result).toEqual({ configured: false, reason: "missing-git" });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["read", "write"])("warns without fallback when Git config %s fails", (operation) => {
    const { result, warn, spawnSync } = configure([
      { status: 0, stdout: "true\n" },
      ...(operation === "write" ? [{ status: 1 }] : []),
      { status: 128, stderr: "permission denied" },
    ]);
    expect(result).toEqual({ configured: false, reason: "config-failed" });
    expect(warn).toHaveBeenCalledWith("[prepare] could not configure git hooks: permission denied");
    expect(spawnSync).toHaveBeenCalledTimes(operation === "write" ? 3 : 2);
  });

  it("skips packaged installs without the source hook directory", () => {
    const { result, spawnSync } = configure([], false);
    expect(result).toEqual({ configured: false, reason: "missing-hooks-dir" });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  type OwnershipConfig = {
    linked?: boolean;
    worktreeConfig?: boolean;
    local?: string;
    global?: string;
    overrides?: boolean;
  };
  function ownership(name: string, expected: string | null, config: OwnershipConfig = {}) {
    const reason =
      expected === null
        ? "config-failed"
        : expected === "git-hooks"
          ? "configured"
          : "already-configured";
    return { name, expected, reason, ...config };
  }
  const ownershipCases = [
    ownership("fresh primary", "git-hooks"),
    ownership("explicit global owner", "global-hooks", { global: "global-hooks" }),
    ownership("explicit empty value", "", { local: "" }),
    ownership("linked without private config", null, { linked: true }),
    ownership("linked private initialization", "git-hooks", {
      linked: true,
      worktreeConfig: true,
    }),
    ownership("overrides masking shared config", "linked-hooks", {
      linked: true,
      worktreeConfig: true,
      local: "shared-hooks",
      overrides: true,
    }),
  ];

  it.each(ownershipCases)("preserves Git configuration ownership: $name", (scenario) => {
    const root = tempDirs.make("prepare-hook-ownership-");
    const primary = join(root, "primary");
    const globalConfig = join(root, "global.config");
    const template = join(root, "empty-template");
    mkdirSync(template);
    writeFileSync(globalConfig, "");
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_TEMPLATE_DIR: template,
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
    git(root, ["init", "-q", "--initial-branch=main", primary]);
    git(primary, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    const checkouts = [primary];
    if (scenario.linked) {
      for (const name of ["linked", "sibling"]) {
        const checkout = join(root, name);
        git(primary, ["worktree", "add", "--detach", "-q", checkout, "HEAD"]);
        checkouts.push(checkout);
      }
    }
    const target = scenario.linked ? join(root, "linked") : primary;
    mkdirSync(join(target, "git-hooks"));
    if (scenario.worktreeConfig) {
      git(primary, ["config", "extensions.worktreeConfig", "true"]);
    }
    if (scenario.local !== undefined) {
      git(primary, ["config", "--local", "core.hooksPath", scenario.local]);
    }
    if (scenario.global !== undefined) {
      git(primary, ["config", "--file", globalConfig, "core.hooksPath", scenario.global]);
    }
    if (scenario.overrides) {
      checkouts.forEach((checkout) =>
        git(checkout, ["config", "--worktree", "core.hooksPath", `${basename(checkout)}-hooks`]),
      );
    }
    const hookPath = (cwd: string) => {
      const result = spawnGit("git", ["-C", cwd, "config", "--get", "core.hooksPath"], {
        env,
        encoding: "utf8",
      });
      expect([0, 1]).toContain(result.status);
      return result.status === 0 ? result.stdout.replace(/\r?\n$/u, "") : null;
    };
    const effectiveBefore = checkouts.map(hookPath);
    const sharedConfig = join(primary, ".git", "config");
    const privateConfig = (checkout: string) =>
      resolve(checkout, git(checkout, ["rev-parse", "--git-path", "config.worktree"]));
    const writableConfig =
      scenario.reason !== "configured"
        ? null
        : scenario.worktreeConfig
          ? privateConfig(target)
          : sharedConfig;
    const unchangedFiles = [globalConfig, sharedConfig, ...checkouts.map(privateConfig)].filter(
      (file) => file !== writableConfig,
    );
    const contents = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
    const contentsBefore = unchangedFiles.map(contents);
    const warn = vi.fn();
    const result = configurePrepareGitHooks({
      cwd: target,
      spawnSync: (bin: string, args: string[], options: SpawnSyncOptions) =>
        spawnGit(bin, args, { ...options, env }),
      warn,
    });
    // Private overrides can mask a shared write, so compare config bytes as well as effective values.
    expect(unchangedFiles.map(contents)).toEqual(contentsBefore);
    expect(result).toEqual({
      configured: scenario.reason === "configured",
      reason: scenario.reason,
    });
    expect(checkouts.map(hookPath)).toEqual(
      checkouts.map((checkout, index) =>
        checkout === target ? scenario.expected : effectiveBefore[index],
      ),
    );
    if (scenario.reason === "config-failed") {
      expect(warn).toHaveBeenCalledOnce();
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
