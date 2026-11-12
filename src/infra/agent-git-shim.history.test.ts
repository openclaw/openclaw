import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { AGENT_GIT_SHIM } from "./agent-git-shim.js";

async function withHistoryFixture(
  run: (fixture: Awaited<ReturnType<typeof historyFixture>>) => Promise<void>,
) {
  await withTempDir("agent-git-blobs-", async (root) => run(await historyFixture(root)));
}

async function historyFixture(root: string, versions = 12, append = true) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, args: string[], input?: string) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, input, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const origin = path.join(root, "origin");
  const seed = path.join(root, "seed");
  const file = "folder/history file.txt";
  const shim = path.join(root, "git");
  await fs.writeFile(shim, AGENT_GIT_SHIM, { mode: 0o755 });
  git(root, ["init", "--initial-branch=main", origin]);
  git(origin, ["config", "uploadpack.allowFilter", "true"]);
  let input = "";
  let content = "";
  for (let index = 0; index < versions; index++) {
    content = `${append ? content : ""}history line ${index}\n`;
    const other = `unrelated version ${index}\n`;
    input += `commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> ${1700000000 + index} +0000\ndata 7\nhistory\nM 100644 inline ${file}\ndata ${content.length}\n${content}\nM 100644 inline other.txt\ndata ${other.length}\n${other}\n`;
  }
  git(origin, ["fast-import", "--quiet"], input);
  git(origin, ["reset", "--hard", "HEAD"]);
  git(origin, ["repack", "-adq"]);
  git(root, ["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(origin).href, seed]);
  const seedHead = git(origin, ["rev-parse", "HEAD"]).trim();
  await fs.writeFile(path.join(origin, file), "new tip\n");
  git(origin, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-am",
    "origin advanced",
  ]);
  // Keep the oracle at the reader's revision while origin advertises a newer main.
  const oracle = path.join(root, "oracle");
  git(origin, ["worktree", "add", "--detach", oracle, seedHead]);
  let sequence = 0;
  const reader = async () => {
    const base = path.join(root, `base-${sequence}`);
    const linked = path.join(root, `reader ${sequence++}`);
    await fs.cp(seed, base, { recursive: true });
    git(base, ["config", "gc.auto", "0"]);
    git(base, ["config", "maintenance.auto", "false"]);
    git(base, ["worktree", "add", "--detach", linked]);
    const packet = path.join(root, `packet-${sequence}`);
    const packs = async () =>
      (await fs.readdir(path.join(base, ".git/objects/pack"))).filter((name) =>
        name.endsWith(".pack"),
      );
    const before = await packs();
    const invoke = (args: string[], cwd = linked, extraEnv: NodeJS.ProcessEnv = {}) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(shim, ["-C", root, "-C", cwd, ...args], {
          cwd: root,
          env: { ...env, GIT_TRACE_PACKET: packet, ...extraEnv },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    const newPacks = async () => (await packs()).filter((name) => !before.includes(name));
    const requests = async () => {
      const trace = await fs.readFile(packet, "utf8").catch(() => "");
      return [...trace.matchAll(/fetch> want ([a-f0-9]+)/g)].map((match) => match[1]);
    };
    return { base, linked, invoke, newPacks, requests };
  };
  return { root, origin: oracle, file, git, reader };
}

it.skipIf(process.platform === "win32")(
  "batches historical blobs while preserving native command output and path scope",
  () =>
    withHistoryFixture(async ({ origin, file, git, reader }) => {
      for (const args of [
        ["log", "-p", "--", file],
        ["log", "--stat", "--max-count=3", "--", file],
        ["log", "--patch", "HEAD~5..HEAD~1", "--", file],
        ["blame", "HEAD", "--", file],
        ["blame", file],
        ["diff", "HEAD~8", "HEAD~2", "--", file],
      ]) {
        const { invoke, newPacks, requests } = await reader();
        const result = await invoke(args);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout, args.join(" ")).toBe(git(origin, args));
        expect.soft(await newPacks(), args.join(" ")).toHaveLength(1);
        const wanted = await requests();
        expect.soft(new Set(wanted).size, args.join(" ")).toBe(wanted.length);
        const unrelated = git(origin, [
          "log",
          "--format=",
          "--raw",
          "--no-abbrev",
          "--",
          "other.txt",
        ]);
        for (const oid of wanted) {
          expect(unrelated, args.join(" ")).not.toContain(oid);
        }
        if (args[0] === "diff") {
          expect(wanted).toHaveLength(2);
        }
      }
      const { linked, invoke, newPacks } = await reader();
      for (const revision of ["HEAD~10", "HEAD~5", "HEAD~1"]) {
        const args = ["show", `${revision}:./history file.txt`];
        const result = await invoke(args, path.join(linked, "folder"));
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(git(path.join(origin, "folder"), args));
      }
      expect(await newPacks()).toHaveLength(1);
    }),
);

it.skipIf(process.platform === "win32")(
  "shares overlapping blob prefetches across linked worktrees and keeps offline reads offline",
  () =>
    withHistoryFixture(async ({ root, origin, file, git, reader }) => {
      for (const overlap of [false, true]) {
        const { base, linked, invoke, newPacks, requests } = await reader();
        const peer = path.join(root, overlap ? "overlap peer" : "identical peer");
        git(base, ["worktree", "add", "--detach", peer]);
        const first = ["log", "-p", ...(overlap ? ["--max-count=5"] : []), "--", file];
        const second = ["log", "-p", "--", file];
        const results = await Promise.all([invoke(first, linked), invoke(second, peer)]);
        for (const [index, result] of results.entries()) {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toBe(git(origin, index === 0 ? first : second));
        }
        expect((await newPacks()).length).toBeLessThanOrEqual(overlap ? 2 : 1);
        const wanted = await requests();
        expect(new Set(wanted).size).toBe(wanted.length);
      }
      const { invoke, newPacks, requests } = await reader();
      const result = await invoke(["log", "-p", "--", file], undefined, { GIT_NO_LAZY_FETCH: "1" });
      expect(result.code).not.toBe(0);
      expect((await invoke(["--no-lazy-fetch", "log", "-p", "--", file])).code).not.toBe(0);
      expect(await newPacks()).toHaveLength(0);
      expect(await requests()).toHaveLength(0);
      const metadata = ["log", "--format=%H", "--", file];
      expect((await invoke(metadata)).stdout).toBe(git(origin, metadata));
      expect(await requests()).toHaveLength(0);
      const unsupported = ["show", "--format=short", `HEAD~1:${file}`];
      const shown = await invoke(unsupported);
      expect(shown.code, shown.stderr).toBe(0);
      expect(shown.stdout).toBe(git(origin, unsupported));
      expect(await requests()).toHaveLength(1);
    }),
);

it.skipIf(process.platform === "win32")(
  "falls back to one requested blob when a path history exceeds the batch bound",
  () =>
    withTempDir("agent-git-blob-bound-", async (root) => {
      const { origin, file, git, reader } = await historyFixture(root, 2050, false);
      const { invoke, requests } = await reader();
      const args = ["show", `HEAD~1:${file}`];
      const result = await invoke(args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(git(origin, args));
      expect(await requests()).toHaveLength(1);
    }),
);
