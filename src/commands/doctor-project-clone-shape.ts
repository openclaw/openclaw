import { note } from "../../packages/terminal-core/src/note.js";
import { gitEnvironment } from "../agents/worktrees/git.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../config/config.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { listProjectRegistry } from "../projects/project-registry.js";

const CHECK_ID = "core/doctor/project-clone-shape";

function describeCloneConfigKey(key: string) {
  if (!key.startsWith("remote.")) {
    return { name: key, urlKey: false };
  }
  const fieldOffset = key.lastIndexOf(".");
  const remote = key.slice("remote.".length, fieldOffset);
  if (!/(:\/\/|::|@)/.test(remote)) {
    return { name: key, urlKey: false };
  }
  // Git addresses include remote-helper and scp forms, not just WHATWG URLs.
  // Preserve transport/scheme labels but conservatively mask through the final @.
  const transport = /^(?:[^:/?#@]+::)+/.exec(remote)?.[0] ?? "";
  let address = remote.slice(transport.length);
  const userInfoEnd = address.lastIndexOf("@");
  if (userInfoEnd >= 0) {
    const schemeEnd = address.indexOf("://");
    const prefixLength =
      schemeEnd >= 0 && schemeEnd < userInfoEnd ? schemeEnd + 3 : address.startsWith("//") ? 2 : 0;
    address = `${address.slice(0, prefixLength)}***@${address.slice(userInfoEnd + 1)}`;
  }
  address = address.split(/[?#]/, 1)[0] ?? "";
  return { name: `remote.${transport}${address}${key.slice(fieldOffset)}`, urlKey: true };
}

async function readCloneGit(root: string, args: string[], optional = false): Promise<string> {
  const result = await executeGitCommand(root, args, {
    env: gitEnvironment({ ...process.env, GIT_NO_LAZY_FETCH: "1" }),
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  });
  if (
    result.termination !== "exit" ||
    result.stdoutTruncatedBytes ||
    (result.code !== 0 && !(optional && result.code === 1))
  ) {
    throw new Error("clone inspection unavailable");
  }
  return result.stdout;
}

export async function collectProjectCloneShapeHealthFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  let projects;
  try {
    projects = listProjectRegistry(cfg).filter((project) => project.source === "cloned");
  } catch {
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        message: "Skipped project clone inspection: the project registry is unreadable.",
        fixHint: "Restore access to the project registry and rerun openclaw doctor.",
      },
    ];
  }
  for (const project of projects) {
    try {
      const config = await readCloneGit(
        project.repoRoot,
        [
          "config",
          "--null",
          "--name-only",
          "--get-regexp",
          "^remote\\..*\\.(promisor|partialclonefilter)$",
        ],
        true,
      );
      const shallow = (
        await readCloneGit(project.repoRoot, ["rev-parse", "--is-shallow-repository"])
      ).trim();
      const extension = await readCloneGit(
        project.repoRoot,
        ["config", "--get", "extensions.partialclone"],
        true,
      );
      const keys = [...new Set(config.split("\0").filter(Boolean))]
        .toSorted()
        .map(describeCloneConfigKey);
      if (extension) {
        keys.push(describeCloneConfigKey("extensions.partialclone"));
      }
      if (shallow !== "true" && keys.length === 0) {
        continue;
      }
      const unset = (key: ReturnType<typeof describeCloneConfigKey>) =>
        key.urlKey
          ? [
              `# Before continuing, locate ${key.name} locally; the raw output may contain credentials:`,
              "# git config --get-regexp '^remote\\..*\\.(promisor|partialclonefilter)$'",
              "# Then run: git config --unset-all <the key shown by that command>",
            ]
          : [`git config --unset-all ${quoteCliArg(key.name)}`];
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        path: project.repoRoot,
        message: `Project clone ${project.displayName} (${project.id}): shallow=${shallow}; partial-clone keys: ${keys.map((key) => key.name).join(", ") || "none"}. Full clones are recommended for managed worktrees.`,
        fixHint: [
          "Manual repair only (POSIX shell); stop on any failed step:",
          `cd ${quoteCliArg(project.repoRoot)}`,
          ...keys.filter((key) => key.name.endsWith(".partialclonefilter")).flatMap(unset),
          `git fetch --refetch${shallow === "true" ? " --unshallow" : ""} origin`,
          "git rev-list --objects --missing=print --all | grep '^?' | cut -c2- | git fetch origin --no-tags --no-write-fetch-head --recurse-submodules=no --stdin",
          ...keys
            .filter(
              (key) => key.name.endsWith(".promisor") || key.name === "extensions.partialclone",
            )
            .flatMap(unset),
          "git repack -a -d",
          "Rerun openclaw doctor. If history or objects remain missing, recover them from the original repository.",
        ].join("\n"),
      });
    } catch {
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        path: project.repoRoot,
        message: `Skipped project clone ${project.displayName} (${project.id}): repository is missing, unreadable, or Git inspection did not complete.`,
        fixHint:
          "Check the clone path, permissions, and Git installation, then rerun openclaw doctor.",
      });
    }
  }
  return findings;
}

export async function noteProjectCloneShape(cfg: OpenClawConfig): Promise<void> {
  for (const finding of await collectProjectCloneShapeHealthFindings(cfg)) {
    note(
      [finding.message, finding.path, finding.fixHint].filter(Boolean).join("\n"),
      "Project clones",
    );
  }
}
