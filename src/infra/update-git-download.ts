import path from "node:path";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { acquireFileLock, type FileLockHandle } from "./file-lock.js";
import { ensureAbsoluteDirectory, root as safeRoot, type Root } from "./fs-safe.js";
import { reportUpdateStepCompletion, runStep } from "./update-runner-command.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const OFFICIAL_GITHUB =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)openclaw\/openclaw(?:\.git)?\/?$/iu;
const OBJECT_ID = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
const INVENTORY_LIMIT = 128 * 1024 * 1024;
const OBJECTS_PER_BATCH = 128;

class InterruptedDownload extends Error {}

/** A private Git object store survives disposable inspection repositories and process exits. */
export async function createGitUpdateDownload(params: {
  artifactRoot: string;
  beforeSha: string | null;
  step: () => RunStepOptions;
  probeTimeoutMs: number;
  deadline?: number;
  signal?: AbortSignal;
}) {
  const initialStep = params.step();
  const { cwd: inspectionRoot, runCommand } = initialStep;
  const warning = async (message: string) => {
    const step = params.step();
    const result: UpdateStepResult = {
      name: "git-download-fallback",
      command: "select Git update transport",
      cwd: inspectionRoot,
      durationMs: 0,
      exitCode: 0,
      warnings: [message],
    };
    step.results?.push(result);
    await reportUpdateStepCompletion(step.progress, {
      ...result,
      index: step.stepIndex,
      total: step.totalSteps,
    });
  };
  const signal = resolveCommandProcessSignal(params.signal);
  const deadline =
    params.deadline ??
    (initialStep.timeoutMs === undefined ? undefined : Date.now() + initialStep.timeoutMs);
  const assertActive = () => {
    signal?.throwIfAborted();
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error("Git update download deadline expired");
    }
  };
  const budget = (timeoutMs?: number) => {
    assertActive();
    const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    return timeoutMs === undefined
      ? remaining
      : remaining === undefined
        ? timeoutMs
        : Math.min(timeoutMs, remaining);
  };
  const run: CommandRunner = (argv, options) =>
    runCommand(argv, {
      ...options,
      signal: options.signal ?? signal,
      timeoutMs: budget(options.timeoutMs),
    });
  const git = async (
    args: string[],
    options: Parameters<CommandRunner>[1] = {},
    cwd = inspectionRoot,
  ) => {
    const result = await run(["git", "-C", cwd, "--no-lazy-fetch", ...args], {
      ...options,
      maxOutputBytes: INVENTORY_LIMIT,
      terminateOnOutputLimit: true,
    });
    assertActive();
    if (
      !result.outputLimitExceeded &&
      (result.signal || result.killed || (result.termination && result.termination !== "exit"))
    ) {
      throw new InterruptedDownload(
        `Git update download interrupted (${result.termination ?? result.signal})`,
      );
    }
    if (
      result.code !== 0 ||
      result.signal ||
      result.killed ||
      result.outputLimitExceeded ||
      (result.termination && result.termination !== "exit")
    ) {
      throw new Error(
        `Git update download ${args[0]} failed (${result.termination ?? result.code})`,
      );
    }
    return result.stdout;
  };
  const capability = await run(["git", "--no-lazy-fetch", "version"], {
    timeoutMs: params.probeTimeoutMs,
  });
  assertActive();
  if (
    capability.signal ||
    capability.killed ||
    (capability.termination && capability.termination !== "exit")
  ) {
    throw new InterruptedDownload("Git download capability probe was interrupted");
  }
  if (capability.code !== 0) {
    await warning(
      "Git lacks the read-only missing-object probe; continuing with the existing Git transport",
    );
    return {
      runCommand,
      hydrate: async (_revision: string) => {},
      dispose: async (_success: boolean) => {},
    };
  }
  // Resolve rewrites using Git. Credentials, custom hosts, forks and private repositories
  // retain their original transport; no credentials are sent to the public raw host.
  const remotes = await git(["remote"], { timeoutMs: params.probeTimeoutMs });
  const official = new Set<string>();
  for (const remote of remotes.trim().split("\n").filter(Boolean)) {
    const url = await git(["remote", "get-url", remote], { timeoutMs: params.probeTimeoutMs });
    if (OFFICIAL_GITHUB.test(url.trim())) {
      official.add(remote);
    }
  }
  const promisorConfig = await run(
    ["git", "-C", inspectionRoot, "config", "--get-regexp", "^remote\\..*\\.promisor$"],
    { timeoutMs: params.probeTimeoutMs },
  );
  const promisors = promisorConfig.stdout.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.promisor\s+(?:true|yes|on|1)$/iu.exec(line);
    return match ? [match[1]!] : [];
  });
  const cachePath = path.join(params.artifactRoot, ".artifacts", "git-downloads", "official");
  const repository = path.join(cachePath, "repository.git");
  let cache: Root | undefined;
  let lock: FileLockHandle | undefined;
  let tip: string | undefined;
  let source: string | undefined;
  let attemptedFetch = false;
  let primary: string | undefined;
  let disabled = false;
  const warn = (error: unknown) =>
    warning(`Resumable Git download unavailable; continuing with Git: ${String(error)}`);
  const initialize = async () => {
    if (cache) {
      return;
    }
    const directory = await ensureAbsoluteDirectory(cachePath, {
      mode: 0o700,
      scopeLabel: "Git download cache",
    });
    if (!directory.ok) {
      throw directory.error;
    }
    let acquiring = true;
    try {
      lock = await acquireFileLock(path.join(cachePath, "download"), {
        retries: { retries: 40, factor: 1, minTimeout: 100, maxTimeout: 100 },
        stale: 0,
        staleRecovery: "remove-if-definitely-stale",
        assertResourceUnborrowed: () => {
          if (acquiring) {
            assertActive();
          }
        },
      });
    } finally {
      // Cancellation stops acquisition, but cannot prevent releasing an owned lock.
      acquiring = false;
    }
    assertActive();
    cache = await safeRoot(cachePath);
    await cache.mkdir("repository.git", { private: true });
    await git(["init", "--bare", "--template=", repository], {
      timeoutMs: params.probeTimeoutMs,
      env: {
        GIT_DEFAULT_HASH: params.beforeSha?.length === 64 ? "sha256" : "sha1",
        GIT_DEFAULT_REF_FORMAT: "files",
      },
    });
    const inspection = await safeRoot(inspectionRoot);
    // Copy the installed-object alternate before adding our cache, avoiding an alternate cycle.
    const alternates = await inspection.readText("objects/info/alternates");
    await cache.write("repository.git/objects/info/alternates", alternates);
    await inspection.append(
      "objects/info/alternates",
      `${JSON.stringify(path.join(repository, "objects"))}\n`,
    );
    const cached = await run(
      ["git", "-C", repository, "rev-parse", "--verify", "refs/openclaw/target"],
      { timeoutMs: params.probeTimeoutMs },
    );
    const oid = cached.code === 0 ? cached.stdout.trim() : "";
    tip = OBJECT_ID.test(oid) ? oid : undefined;
    if (!tip) {
      const fetched = await run(
        ["git", "-C", repository, "rev-parse", "--verify", "refs/openclaw/fetched"],
        { timeoutMs: params.probeTimeoutMs },
      );
      tip =
        fetched.code === 0 && OBJECT_ID.test(fetched.stdout.trim())
          ? fetched.stdout.trim()
          : undefined;
    }
  };
  const saveTip = async (revision: string, target = false) => {
    await git(
      ["update-ref", target ? "refs/openclaw/target" : "refs/openclaw/fetched", revision],
      { timeoutMs: params.probeTimeoutMs },
      repository,
    );
    tip = revision;
  };
  const objectEnv = () => ({ GIT_OBJECT_DIRECTORY: path.join(repository, "objects") });
  const wrapped: CommandRunner = async (argv, options) => {
    // Only the existing fetch owner chooses remotes/refspecs. This adapter adds a filter
    // without changing that selection, or the installed repository's configuration.
    if (
      argv[0] !== "git" ||
      argv[1] !== "-C" ||
      argv[2] !== inspectionRoot ||
      argv[3] !== "fetch"
    ) {
      return runCommand(argv, options);
    }
    attemptedFetch = true;
    const remote = argv.slice(4).find((arg) => official.has(arg));
    if (!remote) {
      return runCommand(argv, options);
    }
    if (disabled) {
      return run(argv, options);
    }
    try {
      await initialize();
    } catch (error) {
      assertActive();
      if (error instanceof InterruptedDownload || hasCommandProcessCleanupError(error)) {
        throw error;
      }
      disabled = true;
      await warn(error);
      return run(argv, options);
    }
    const filtered = [
      ...argv.slice(0, 4),
      "--filter=blob:none",
      ...(tip ? [`--negotiation-tip=${tip}`] : []),
      ...argv.slice(4),
    ];
    const fetched = await run(filtered, { ...options, env: { ...options.env, ...objectEnv() } });
    assertActive();
    if (
      fetched.signal ||
      fetched.killed ||
      (fetched.termination && fetched.termination !== "exit")
    ) {
      return fetched;
    }
    if (fetched.code !== 0 || fetched.outputLimitExceeded) {
      // A network failure must not start a larger replacement transfer. Completed
      // cache packs stay available to the next invocation, including metadata packs.
      return fetched;
    }
    source = remote;
    const revision = (
      await git(["rev-parse", "FETCH_HEAD^{commit}"], { timeoutMs: params.probeTimeoutMs })
    ).trim();
    await saveTip(revision);
    return fetched;
  };
  const hydrated = new Set<string>();
  const hydrate = async (revision: string) => {
    if (hydrated.has(revision)) {
      return;
    }
    if (!source && !attemptedFetch && !disabled) {
      // Pinned commits can pass the fetch owner's cached-commit probe while their
      // promised blobs are absent. Use its configured promisor, without ref discovery.
      const promisor = promisors.find((remote) => official.has(remote));
      if (promisor) {
        try {
          await initialize();
          source = promisor;
        } catch (error) {
          assertActive();
          if (error instanceof InterruptedDownload || hasCommandProcessCleanupError(error)) {
            throw error;
          }
          disabled = true;
          await warn(error);
        }
      }
    }
    if (!cache || !source || disabled) {
      return;
    }
    assertActive();
    const history = [revision, ...(params.beforeSha ? [`^${params.beforeSha}`] : [])];
    const inventory = async () => {
      const missing = new Set<string>();
      // Resolve the tree while walking the commit: a promised root tree cannot
      // be parsed as a revision argument before --missing=print takes effect.
      for (const revisions of [history, ["--max-count=1", revision]]) {
        const objects = await git([
          "rev-list",
          "--objects",
          "--no-object-names",
          "--missing=print",
          ...revisions,
        ]);
        for (const line of objects.split("\n")) {
          if (line.startsWith("?") && OBJECT_ID.test(line.slice(1))) {
            missing.add(line.slice(1));
          }
        }
      }
      return missing;
    };
    if (!primary) {
      primary = revision;
      await saveTip(revision, true);
    }
    try {
      while (true) {
        const missing = [...(await inventory())].toSorted();
        if (!missing.length) {
          hydrated.add(revision);
          return;
        }
        // Git retains compression and validates object identity. Each successful
        // pack is a durable checkpoint; only an interrupted batch can be repeated.
        // Count bounds requests without asking for each small file's size over HTTP.
        for (let offset = 0; offset < missing.length; offset += OBJECTS_PER_BATCH) {
          const batch = missing.slice(offset, offset + OBJECTS_PER_BATCH);
          await git(
            [
              "-c",
              // Match Git's promisor fetch: an incomplete target must not be sent
              // as a have, which can make the server omit its promised blobs.
              "fetch.negotiationAlgorithm=noop",
              "fetch",
              source,
              "--no-tags",
              "--no-write-fetch-head",
              "--recurse-submodules=no",
              "--filter=blob:none",
              "--stdin",
            ],
            { input: batch.join("\n") + "\n", env: objectEnv() },
          );
        }
      }
    } catch (error) {
      assertActive();
      if (!(error instanceof InterruptedDownload) && !hasCommandProcessCleanupError(error)) {
        await warning(
          "Git object batch did not complete. Completed batches are retained; retry the update to continue.",
        );
      }
      throw error;
    }
  };

  return {
    runCommand: wrapped,
    async hydrate(revision: string) {
      await runStep({
        ...params.step(),
        runCommand: async () => {
          await hydrate(revision);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
    },
    async dispose(success: boolean) {
      try {
        if (cache && success) {
          await cache.remove("repository.git", { recursive: true, force: true });
        }
      } catch (error) {
        await warning(`Git download cache cleanup failed: ${String(error)}`);
      } finally {
        await lock?.release();
      }
    },
  };
}
