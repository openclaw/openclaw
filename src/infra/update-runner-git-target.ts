import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { gitNullConfigPath } from "./git-exec.js";
import { DEV_BRANCH, isBetaTag, isStableTag, type UpdateChannel } from "./update-channels.js";
import { compareSemverStrings } from "./update-check.js";
import { cleanupUpdateTemporaryDirectory } from "./update-maintenance.js";
import { runStep } from "./update-runner-command.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

const UNVERIFIED_GIT_CORRUPTION =
  /(?:in the commit graph file but not in the object database|probably due to repo corruption)/iu;
const VERIFIED_GIT_CORRUPTION =
  /(?:broken link from|dangling (?:commit|tree|blob)|hash mismatch|invalid sha1 pointer|missing (?:blob|commit|tree)|object corrupt)/iu;

/** Replace Git's unverified corruption guess when promised objects may be intentionally absent. */
export async function classifyPartialCloneGitFailure(params: {
  result: Awaited<ReturnType<CommandRunner>>;
  root: string;
  runCommand: CommandRunner;
  timeoutMs: number;
}): Promise<Awaited<ReturnType<CommandRunner>>> {
  if (params.result.code === 0 || !UNVERIFIED_GIT_CORRUPTION.test(params.result.stderr)) {
    return params.result;
  }
  const promisorConfig = await params
    .runCommand(
      [
        "git",
        "-C",
        params.root,
        "config",
        "--includes",
        "--get-regexp",
        "^remote\\..*\\.promisor$",
      ],
      { cwd: params.root, timeoutMs: params.timeoutMs },
    )
    .catch(() => undefined);
  if (
    promisorConfig?.code === 0 &&
    promisorConfig.stdout.split("\n").some((line) => /\s(?:true|yes|on|1)$/iu.test(line.trim()))
  ) {
    return {
      ...params.result,
      stderr:
        "Git could not resolve one or more promised objects in this partial clone. " +
        "This does not by itself indicate repository corruption. Bulk-fetch the missing object IDs " +
        "from the configured promisor remote, then retry the update (for example: " +
        "git rev-list --objects --missing=print --all | sed -n 's/^?//p' | " +
        'git fetch "<promisor-remote>" --stdin).',
    };
  }
  const fsck = await params
    .runCommand(
      ["git", "--no-lazy-fetch", "-C", params.root, "fsck", "--connectivity-only", "--no-dangling"],
      { cwd: params.root, timeoutMs: params.timeoutMs },
    )
    .catch(() => undefined);
  const fsckOutput = `${fsck?.stdout ?? ""}\n${fsck?.stderr ?? ""}`.trim();
  if (fsck?.code !== 0 && VERIFIED_GIT_CORRUPTION.test(fsckOutput)) {
    return {
      ...params.result,
      stderr: `Git verified repository corruption with git fsck: ${fsckOutput}`,
    };
  }
  return {
    ...params.result,
    stderr:
      "Git reported an object-database inconsistency, but OpenClaw did not verify repository " +
      "corruption with git fsck. Retry the update; if it recurs, inspect the repository with " +
      "git fsck before attempting repair.",
  };
}

function quoteGitConfig(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n").replace(/\t/gu, "\\t").replaceAll("\b", "\\b")}"`;
}

function gitConfigEntry(key: string, value: string): string {
  const match = /^([a-z][a-z0-9-]*)\.(?:(.*)\.)?([a-z][a-z0-9-]*)$/iu.exec(key);
  if (!match || /[\r\n]/u.test(match[2] ?? "")) {
    throw new Error("Could not preserve Git target inspection configuration");
  }
  return `[${match[1]}${match[2] === undefined ? "" : ` ${quoteGitConfig(match[2])}`}]\n\t${match[3]} = ${quoteGitConfig(value)}\n`;
}

/** Fetch and candidate selection must not update the installed repository before admission. */
export async function withGitTargetInspectionRoot<T>(
  params: {
    root: string;
    runCommand: CommandRunner;
    timeoutMs: number;
    onWarning: (step: UpdateStepResult) => void;
  },
  inspect: (root: string, runCommand: CommandRunner) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-admission-"));
  const inspectionRoot = path.join(temporaryRoot, "repository.git");
  const command = async (root: string, args: string[], allowMissing = false) => {
    const result = await params.runCommand(["git", "-C", root, ...args], {
      cwd: root,
      timeoutMs: params.timeoutMs,
    });
    if (result.code !== 0 && !(allowMissing && result.code === 1)) {
      // Configuration can contain credentials; never include its output in errors.
      throw new Error(`Git target inspection ${args[0]} failed (exit ${result.code})`);
    }
    return result.stdout;
  };
  try {
    await command(params.root, [
      "clone",
      "--mirror",
      "--shared",
      "--template=",
      "--",
      params.root,
      inspectionRoot,
    ]);
    await command(inspectionRoot, ["config", "--remove-section", "remote.origin"]);
    const config = await command(
      params.root,
      [
        "config",
        "--includes",
        "--null",
        "--get-regexp",
        "^((remote|branch|url|http|credential|protocol|filter|fetch|transfer|ssh|user|author|committer|gpg)\\.|commit\\.gpgsign$|core\\.(sshcommand|gitproxy|askpass)$)",
      ],
      true,
    );
    const entries: string[] = [];
    for (const entry of config.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\n");
      const key = separator === -1 ? entry : entry.slice(0, separator);
      const value = separator === -1 ? "true" : entry.slice(separator + 1);
      entries.push(gitConfigEntry(key, value));
    }
    await fs.appendFile(path.join(inspectionRoot, "config"), entries.join(""), { mode: 0o600 });
    const runInspectionCommand: CommandRunner = (argv, options) =>
      params.runCommand(
        argv[0] === "git" && argv[1] === "-C" && argv[2] === inspectionRoot
          ? // Keep relative remote URLs rooted at the original checkout, but direct
            // all Git metadata writes to the private mirror's independent Git dir.
            [
              "git",
              "-C",
              // Publication may move a new checkout after validation. Cleanup
              // owns only the private Git dir and needs no source-relative transport.
              argv[3] === "worktree" && (argv[4] === "remove" || argv[4] === "prune")
                ? inspectionRoot
                : params.root,
              `--git-dir=${inspectionRoot}`,
              ...argv.slice(3),
            ]
          : argv,
        argv[0] === "git"
          ? {
              ...options,
              // Source-context includes and worktree settings were flattened
              // above. Do not apply globals twice or reselect includes here.
              env: {
                ...options.env,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: gitNullConfigPath(),
                GIT_CONFIG_COUNT: "0",
              },
            }
          : options,
      );
    return await inspect(inspectionRoot, runInspectionCommand);
  } finally {
    // Only this invocation's private inspection clone, never the installed checkout.
    await cleanupUpdateTemporaryDirectory({
      directory: temporaryRoot,
      root: params.root,
      name: "git target inspection cleanup",
      onWarning: params.onWarning,
    });
  }
}

type GitTargetSchemaMetadata =
  | { status: "ok"; version?: string; schemaVersions?: OpenClawSchemaVersions }
  | { status: "unreadable"; reason: string };

export async function readGitTargetSchemaVersions(params: {
  runCommand: CommandRunner;
  root: string;
  revision: string;
  timeoutMs: number;
}): Promise<GitTargetSchemaMetadata> {
  let result: Awaited<ReturnType<CommandRunner>>;
  try {
    result = await params.runCommand(
      ["git", "-C", params.root, "show", `${params.revision}:package.json`],
      { cwd: params.root, timeoutMs: params.timeoutMs },
    );
  } catch (error) {
    return { status: "unreadable", reason: String(error) };
  }
  if (result.code !== 0) {
    return {
      status: "unreadable",
      reason: `git show ${params.revision}:package.json exited ${result.code}`,
    };
  }
  try {
    const manifest: unknown = JSON.parse(result.stdout);
    const schemaVersions = parsePackageOpenClawSchemaVersions(manifest);
    const version = normalizeNullableString(asNullableRecord(manifest)?.version);
    return {
      status: "ok",
      ...(version ? { version } : {}),
      ...(schemaVersions ? { schemaVersions } : {}),
    };
  } catch (error) {
    return { status: "unreadable", reason: `target package.json unparseable: ${String(error)}` };
  }
}

export async function prepareGitMutation(params: {
  runCommand: CommandRunner;
  root: string;
  revision: string;
  timeoutMs: number;
  beforeGitMutation?: UpdateRunnerOptions["beforeGitMutation"];
}): Promise<{
  allowGatewayServiceRepair?: boolean;
  allowGatewayActivation?: boolean;
}> {
  const target = await readGitTargetSchemaVersions(params);
  const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(params.revision)
    ? params.revision.toLowerCase()
    : undefined;
  const preparation = await params.beforeGitMutation?.({
    ...(sha ? { sha } : {}),
    ...(target.status === "ok"
      ? {
          ...(target.version ? { version: target.version } : {}),
          ...(target.schemaVersions ? { schemaVersions: target.schemaVersions } : {}),
        }
      : { metadataUnreadable: target.reason }),
  });
  return preparation ?? {};
}

export async function selectGitInspectionTarget(
  params: Parameters<typeof runGitCandidatePreflight>[0] & {
    channel: UpdateChannel;
    beforeCandidate: (revision: string) => Promise<void>;
  },
) {
  const tag =
    params.channel === "dev"
      ? undefined
      : await resolveChannelTag(
          params.runCommand,
          params.gitRoot,
          params.timeoutMs,
          params.channel,
        );
  if (params.channel !== "dev" && !tag) {
    return { status: "error" as const, reason: "no-release-tag" };
  }
  return runGitCandidatePreflight({ ...params, targetRevision: tag ?? undefined });
}

export async function readBranchName(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runCommand(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs,
  }).catch(() => null);
  const branch = result?.code === 0 ? result.stdout.trim() : "";
  return branch || null;
}

async function listGitTags(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
): Promise<string[]> {
  const result = await runCommand(["git", "-C", root, "tag", "--list", "v*", "--sort=-v:refname"], {
    timeoutMs,
  }).catch(() => null);
  return result?.code === 0 ? normalizeStringEntries(result.stdout.split("\n")) : [];
}

/**
 * Picks the single remote release tags are force-fetched from. The checkout's
 * retained tracking remote (`branch.<main>.remote`) wins when it is still
 * declared, because a detached release checkout keeps that config and a fork
 * `origin` can be tag-less; otherwise the clone's canonical `origin`, then the
 * only declared remote. Multiple non-origin remotes need explicit tracking.
 */
function resolveReleaseTagRemote(
  remotes: readonly string[],
  trackedUpdateRemote: string,
): string | undefined {
  if (trackedUpdateRemote && remotes.includes(trackedUpdateRemote)) {
    return trackedUpdateRemote;
  }
  return remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
}

export async function fetchGitUpdateTarget(params: {
  root: string;
  channel: UpdateChannel;
  name: string;
  step: (name: string, argv: string[], cwd: string) => RunStepOptions;
  steps: UpdateStepResult[];
}): Promise<boolean> {
  const { root, channel, name, step: targetStep, steps } = params;
  const fetch = await runStep(
    targetStep(
      name,
      ["git", "-C", root, "fetch", "--all", "--prune", "--no-tags", "--no-prune-tags"],
      root,
    ),
  );
  if (fetch.exitCode !== 0 || channel === "dev") {
    return fetch.exitCode === 0;
  }
  const remote = await runStep(targetStep("git remote", ["git", "-C", root, "remote"], root));
  if (remote.exitCode !== 0) {
    return false;
  }
  const remotes = normalizeStringEntries((remote.stdoutTail ?? "").split("\n"));
  const tracked = await runStep(
    targetStep(
      "git config update upstream",
      ["git", "-C", root, "config", "--get", `branch.${DEV_BRANCH}.remote`],
      root,
    ),
  );
  if (tracked.exitCode !== 0 && tracked.exitCode !== 1) {
    return false;
  }
  const tagRemote = resolveReleaseTagRemote(remotes, (tracked.stdoutTail ?? "").trim());
  if (!tagRemote) {
    steps.push({
      name: "git release remote",
      command: "git remote",
      cwd: root,
      durationMs: 0,
      exitCode: 1,
      stderrTail:
        "Cannot determine the release remote. Set branch.main.remote to the remote that publishes releases.",
    });
    return false;
  }
  // Only the release authority may replace shared tag refs. Disable pruning
  // even when Git config enables it, so operator-only tags survive.
  const tags = await runStep(
    targetStep(
      `git fetch tags ${tagRemote}`,
      [
        "git",
        "-C",
        root,
        "fetch",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        tagRemote,
        "+refs/tags/*:refs/tags/*",
      ],
      root,
    ),
  );
  return tags.exitCode === 0;
}

export async function resolveChannelTag(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  channel: Exclude<UpdateChannel, "dev">,
): Promise<string | null> {
  const tags = await listGitTags(runCommand, root, timeoutMs);
  return selectChannelTag(tags, channel);
}

export function selectChannelTag(
  tags: readonly string[],
  channel: Exclude<UpdateChannel, "dev">,
): string | null {
  const orderedTags = normalizeStringEntries(tags).toSorted((left, right) => {
    const comparison = compareSemverStrings(left, right);
    return comparison == null ? right.localeCompare(left) : -comparison;
  });
  if (channel === "beta") {
    const betaTag = orderedTags.find((tag) => isBetaTag(tag)) ?? null;
    const stableTag = orderedTags.find((tag) => isStableTag(tag)) ?? null;
    if (!betaTag) {
      return stableTag;
    }
    if (!stableTag) {
      return betaTag;
    }
    const comparison = compareSemverStrings(betaTag, stableTag);
    return comparison != null && comparison < 0 ? stableTag : betaTag;
  }
  return orderedTags.find((tag) => isStableTag(tag)) ?? null;
}
