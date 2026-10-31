import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGitUpdateDownload } from "./update-git-download.js";
import type { CommandRunner } from "./update-runner-types.js";

const official = "https://github.com/openclaw/openclaw.git";
const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const directory = temporary.make("openclaw-git-download-");
  const source = path.join(directory, "source");
  const installed = path.join(directory, "installed");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(directory, "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  fs.mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Download fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "uploadpack.allowFilter", "true");
  git(source, "config", "uploadpack.allowAnySHA1InWant", "true");
  const commit = (message: string) => {
    git(source, "add", "-A");
    git(source, "commit", "-m", message);
    return git(source, "rev-parse", "HEAD");
  };
  fs.writeFileSync(path.join(source, "small.txt"), "retained small file\n");
  fs.writeFileSync(path.join(source, "retained.txt"), "unchanged small file\n");
  const beforeSha = commit("installed");
  git(directory, "clone", source, installed);
  const payloads = ["historical version\n", "renamed version\n", "current version\n"].map((value) =>
    Buffer.from(value),
  );
  for (let index = 0; index < 260; index++) {
    fs.writeFileSync(
      path.join(source, `bulk-${index}.txt`),
      `shared payload for file ${index}\n`.repeat(10),
    );
  }
  fs.writeFileSync(path.join(source, "large file.bin"), payloads[0]!);
  commit("first historical version");
  fs.unlinkSync(path.join(source, "large file.bin"));
  fs.writeFileSync(path.join(source, "renamed #file.bin"), payloads[1]!);
  const fallback = commit("rename and replace historical version");
  fs.unlinkSync(path.join(source, "renamed #file.bin"));
  fs.writeFileSync(path.join(source, "current.bin"), payloads[2]!);
  fs.writeFileSync(path.join(source, "small.txt"), "new small file\n");
  const target = commit("delete historical file and add current version");
  const fetches: string[] = [];
  const batches: Array<{ oids: string[]; completed: boolean }> = [];
  let failBatch = 0;
  let failure: "signal" | "disk-full" = "signal";
  let nextInspection = 0;
  const runCommand: CommandRunner = async (argv, options) => {
    const actual = [...argv];
    if (actual.includes("fetch")) {
      const remoteIndex = actual.indexOf("origin", actual.indexOf("fetch") + 1);
      if (remoteIndex !== -1) {
        const cwd = actual[actual.indexOf("-C") + 1]!;
        const remoteUrl = git(cwd, "remote", "get-url", "origin");
        actual.splice(1, 0, "-c", `url.${pathToFileURL(source).href}.insteadOf=${remoteUrl}`);
      }
    }
    const input =
      typeof options.input === "string"
        ? options.input
        : Buffer.from(options.input ?? []).toString("utf8");
    const batch =
      actual.includes("fetch") && actual.includes("--stdin") && input
        ? { oids: input.trim().split("\n"), completed: false }
        : undefined;
    if (batch) {
      batches.push(batch);
      if (batches.length === failBatch) {
        if (failure === "disk-full") {
          return {
            code: 128,
            stdout: "",
            stderr: "fatal: cannot write Git cache pack: No space left on device (ENOSPC)",
            termination: "exit",
          };
        }
        return {
          code: null,
          stdout: "",
          stderr: "injected interrupted Git transfer",
          signal: "SIGTERM",
          termination: "signal",
          killed: true,
        };
      }
    }
    const result = spawnSync(actual[0]!, actual.slice(1), {
      cwd: options.cwd,
      env: { ...env, ...options.env },
      encoding: "utf8",
      input: options.input,
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (actual.includes("fetch")) {
      fetches.push(result.stderr ?? "");
    }
    if (batch) {
      batch.completed = result.status === 0;
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const create = async (
    overrides: { signal?: AbortSignal; deadline?: number } = {},
    remote = official,
    partialClone = false,
  ) => {
    const inspection = path.join(directory, `inspection-${nextInspection++}.git`);
    git(directory, "clone", "--bare", installed, inspection);
    git(inspection, "remote", "set-url", "origin", remote);
    git(inspection, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    if (partialClone) {
      git(inspection, "config", "remote.origin.promisor", "true");
      const omitted = git(installed, "rev-parse", "HEAD:retained.txt");
      for (const objects of [
        path.join(installed, ".git/objects"),
        path.join(inspection, "objects"),
      ]) {
        fs.rmSync(path.join(objects, omitted.slice(0, 2), omitted.slice(2)), { force: true });
      }
    }
    fs.writeFileSync(
      path.join(inspection, "objects/info/alternates"),
      `${path.join(installed, ".git/objects")}\n`,
    );
    const warnings: string[] = [];
    const download = await createGitUpdateDownload({
      artifactRoot: installed,
      beforeSha,
      step: () => ({
        cwd: inspection,
        runCommand,
        argv: [],
        name: "git-download-objects",
        stepIndex: 0,
        totalSteps: 1,
        progress: {
          onStepComplete: (entry) => {
            warnings.push(...(entry.warnings ?? []));
          },
        },
      }),
      probeTimeoutMs: 5000,
      ...overrides,
    });
    const fetch = () =>
      download.runCommand(
        ["git", "-C", inspection, "fetch", "--progress", "origin", "refs/heads/main"],
        { timeoutMs: 5000 },
      );
    return { inspection, warnings, download, fetch };
  };
  return {
    directory,
    source,
    installed,
    beforeSha,
    target,
    fallback,
    payloads,
    git,
    fetches,
    batches,
    interruptBatch: (index: number, kind: typeof failure) => {
      failBatch = index;
      failure = kind;
    },
    create,
  };
}

it.each(["signal", "disk-full"] as const)(
  "keeps completed compressed Git batches after %s and resumes only missing history objects",
  async (failure) => {
    const state = fixture();
    state.interruptBatch(2, failure);
    const first = await state.create();
    try {
      expect((await first.fetch()).code).toBe(0);
      await expect(first.download.hydrate(state.target)).rejects.toThrow(
        failure === "signal" ? /interrupted/iu : /failed/u,
      );
      if (failure === "disk-full") {
        expect(first.warnings.join(" ")).toContain("Completed batches are retained");
      }
      expect(state.batches).toHaveLength(2);
      expect(state.batches[0]!.completed).toBe(true);
      expect(state.batches[0]!.oids).toHaveLength(128);
      expect(state.batches[1]!.completed).toBe(false);
      expect(
        state.git(
          first.inspection,
          "--no-lazy-fetch",
          "cat-file",
          "-t",
          state.batches[0]!.oids[0]!,
        ),
      ).toBe("blob");
    } finally {
      await first.download.dispose(false);
    }
    fs.rmSync(first.inspection, { recursive: true });
    const completed = new Set(state.batches[0]!.oids);
    const resumed = await state.create();
    try {
      const metadata = await resumed.fetch();
      expect(metadata.code).toBe(0);
      expect(metadata.stderr).not.toContain("Receiving objects");
      await resumed.download.hydrate(state.target);
      expect(resumed.warnings).toEqual([]);
      const retried = state.batches.slice(2).flatMap((batch) => batch.oids);
      expect(retried.length).toBeGreaterThan(128);
      expect(retried.some((oid) => completed.has(oid))).toBe(false);
      expect(state.batches.every((batch) => batch.oids.length <= 128)).toBe(true);
      expect(
        state.git(
          resumed.inspection,
          "--no-lazy-fetch",
          "rev-list",
          "--objects",
          "--missing=print",
          state.target,
          `^${state.beforeSha}`,
        ),
      ).not.toContain("?");
      expect(
        state.git(
          resumed.inspection,
          "--no-lazy-fetch",
          "show",
          `${state.fallback}:renamed #file.bin`,
        ),
      ).toBe(state.payloads[1]!.toString().trim());
      expect(state.git(resumed.inspection, "rev-parse", `${state.target}^{tree}`)).toBe(
        state.git(state.source, "rev-parse", `${state.target}^{tree}`),
      );
      expect(state.git(state.installed, "rev-parse", "HEAD")).toBe(state.beforeSha);
    } finally {
      await resumed.download.dispose(true);
    }
  },
);

it("keeps a custom remote on its original Git path without a download cache", async () => {
  const state = fixture();
  const active = await state.create({}, "https://github.com/example/custom.git");
  try {
    expect((await active.fetch()).code).toBe(0);
    await active.download.hydrate(state.target);
    expect(active.warnings).toEqual([]);
    expect(fs.existsSync(path.join(state.installed, ".artifacts/git-downloads"))).toBe(false);
    expect(
      state.git(
        active.inspection,
        "--no-lazy-fetch",
        "rev-list",
        "--objects",
        "--missing=print",
        state.target,
        `^${state.beforeSha}`,
      ),
    ).not.toContain("?");
  } finally {
    await active.download.dispose(true);
  }
});

it.each(["blob:none", "tree:0"] as const)(
  "hydrates a cached pinned commit from %s through its official promisor without refreshing remote refs",
  async (filter) => {
    const state = fixture();
    state.git(state.installed, "remote", "set-url", "origin", official);
    state.git(
      state.installed,
      "-c",
      `url.${pathToFileURL(state.source).href}.insteadOf=${official}`,
      "fetch",
      `--filter=${filter}`,
      "origin",
      "refs/heads/main",
    );
    expect(state.git(state.installed, "--no-lazy-fetch", "cat-file", "-t", state.target)).toBe(
      "commit",
    );
    const active = await state.create({}, official, true);
    const refs = state.git(active.inspection, "for-each-ref", "--format=%(refname) %(objectname)");
    const missingBefore = state.git(
      active.inspection,
      "--no-lazy-fetch",
      "rev-list",
      "--objects",
      "--missing=print",
      state.target,
      `^${state.beforeSha}`,
    );
    expect(missingBefore).toContain("?");
    if (filter === "tree:0") {
      const targetTree = state.git(state.source, "rev-parse", `${state.target}^{tree}`);
      expect(missingBefore.split("\n")).toContain(`?${targetTree}`);
    }
    try {
      // The target commit is already cached, so the updater intentionally skips discovery fetch.
      await active.download.hydrate(state.target);
      expect(active.warnings).toEqual([]);
      expect(state.batches.length).toBeGreaterThan(0);
      expect(state.batches.every((batch) => batch.completed && batch.oids.length <= 128)).toBe(
        true,
      );
      expect(state.fetches).toHaveLength(state.batches.length);
      expect(
        state.git(active.inspection, "for-each-ref", "--format=%(refname) %(objectname)"),
      ).toBe(refs);
      expect(
        state.git(
          active.inspection,
          "--no-lazy-fetch",
          "rev-list",
          "--objects",
          "--missing=print",
          state.target,
          `^${state.beforeSha}`,
        ),
      ).not.toContain("?");
      state.git(active.inspection, "--no-lazy-fetch", "fsck", "--strict", "--no-dangling");
    } finally {
      await active.download.dispose(false);
    }
    fs.rmSync(active.inspection, { recursive: true });
    const repository = path.join(
      state.installed,
      ".artifacts/git-downloads/official/repository.git",
    );
    const newBlob = state.git(state.source, "rev-parse", `${state.target}:bulk-0.txt`);
    expect(state.git(repository, "--no-lazy-fetch", "cat-file", "-t", newBlob)).toBe("blob");
    expect(state.git(state.installed, "rev-parse", "HEAD")).toBe(state.beforeSha);
  },
);

it("hydrates a pre-existing partial clone's small promised objects through compressed Git batches", async () => {
  const state = fixture();
  const omitted = state.git(state.installed, "rev-parse", "HEAD:retained.txt");
  const active = await state.create({}, official, true);
  try {
    expect((await active.fetch()).code).toBe(0);
    await active.download.hydrate(state.target);
    expect(active.warnings).toEqual([]);
    expect(state.batches.some((batch) => batch.oids.includes(omitted))).toBe(true);
    expect(state.batches.every((batch) => batch.oids.length <= 128)).toBe(true);
    expect(
      state.git(active.inspection, "--no-lazy-fetch", "show", `${state.target}:retained.txt`),
    ).toBe("unchanged small file");
    expect(
      state.git(
        active.inspection,
        "--no-lazy-fetch",
        "rev-list",
        "--objects",
        "--missing=print",
        state.target,
        `^${state.beforeSha}`,
      ),
    ).not.toContain("?");
  } finally {
    await active.download.dispose(true);
  }
});

it.each(["cancelled", "expired"] as const)(
  "does not start or fall back to network work when %s",
  async (kind) => {
    const state = fixture();
    const controller = new AbortController();
    let active: Awaited<ReturnType<typeof state.create>> | undefined;
    try {
      if (kind === "cancelled") {
        active = await state.create({ signal: controller.signal });
        controller.abort(new Error("download cancelled"));
        await expect(active.fetch()).rejects.toThrow("download cancelled");
      } else {
        await expect(state.create({ deadline: Date.now() - 1 })).rejects.toThrow(/deadline/u);
      }
      expect(state.fetches).toHaveLength(0);
    } finally {
      await active?.download.dispose(false);
    }
  },
);
