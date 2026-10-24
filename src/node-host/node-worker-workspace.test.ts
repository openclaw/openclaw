import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const identity = { gatewayNamespace: "gw", environmentId: "env", sessionId: "s1", generation: 1 };
const key = "a".repeat(64);
const maxAgeMs = 6 * 60 * 60 * 1_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let home: string;
let seeds: string;
let workspace: string;
let runtime: NodeWorkerWorkspaceRuntime;
const exec = (argv: string[], sessionId = identity.sessionId) =>
  runtime.exec({ ...identity, sessionId, argv });
const seed = (action: "apply" | "store", sessionId = identity.sessionId) =>
  runtime.exec({
    ...identity,
    sessionId,
    argv: ["openclaw-internal-workspace-seed"],
    seed: action === "store" ? { action, key, maxAgeMs } : { action, key },
  });
const write = (name: string, text: string, dir = workspace) =>
  fsp.writeFile(path.join(dir, name), text);
const read = (dir = workspace) => fsp.readFile(path.join(dir, "tracked.txt"), "utf8");
const age = async (dir: string, milliseconds: number) => {
  const time = new Date(Date.now() - milliseconds);
  await fsp.utimes(dir, time, time);
  return time;
};

beforeEach(async () => {
  home = tempDirs.make("workspace-seeds-");
  seeds = path.join(home, ".openclaw-worker", "git-seeds", identity.gatewayNamespace);
  runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(home, "state", "node-host"),
    env: { ...process.env, HOME: home },
  });
  workspace = (await exec(["node", "-e", ""])).workspaceDir;
});

it("stores a snapshot outside state and replaces the whole workspace on apply", async () => {
  await expect(fsp.stat(path.dirname(seeds))).rejects.toMatchObject({ code: "ENOENT" });
  const git = async (...args: string[]) => {
    const result = await exec(["git", ...args]);
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  await git("init");
  await write("tracked.txt", "original");
  await fsp.symlink("tracked.txt", path.join(workspace, "link.txt"));
  await git("add", ".");
  await git("-c", "user.name=Seed", "-c", "user.email=seed@test", "commit", "-m", "seed");
  const commit = await git("rev-parse", "HEAD");
  expect((await seed("store")).stdout).toBe("stored\n");
  await write("tracked.txt", "changed");
  await write("session-only.txt", "private");
  const old = await age(path.join(seeds, key), 60_000);
  expect(await seed("apply")).toMatchObject({
    workspaceDir: workspace,
    code: 0,
    stdout: "applied\n",
  });
  expect((await fsp.readdir(workspace)).toSorted()).toEqual([".git", "link.txt", "tracked.txt"]);
  expect(await read()).toBe("original");
  expect(await fsp.readlink(path.join(workspace, "link.txt"))).toBe("tracked.txt");
  // Apply must not refresh the store-freshness clock.
  expect((await fsp.stat(path.join(seeds, key))).mtimeMs).toBeLessThanOrEqual(old.getTime());
  expect(await git("rev-parse", "HEAD")).toBe(commit);
  expect(await git("status", "--porcelain")).toBe("");
  await write("tracked.txt", "later edit");
  expect(await read((await seed("apply", "session-2")).workspaceDir)).toBe("original");
});

it("returns absent and empties an existing workspace when no seed exists", async () => {
  await write("stale.txt", "stale");
  expect((await seed("apply")).stdout).toBe("absent\n");
  expect(await fsp.readdir(workspace)).toEqual([]);
});

it("keeps a fresh seed and replaces it only after its freshness window", async () => {
  const seedDir = path.join(seeds, key);
  await write("tracked.txt", "original");
  await seed("store");
  await write("tracked.txt", "updated");
  expect((await seed("store")).stdout).toBe("fresh\n");
  expect(await read(seedDir)).toBe("original");
  await age(seedDir, maxAgeMs + 1_000);
  expect((await seed("store")).stdout).toBe("stored\n");
  expect(await read(seedDir)).toBe("updated");
});

it("prunes old and excess seeds while preserving recent temporary copies", async () => {
  await fsp.mkdir(seeds, { recursive: true });
  const entries = Array.from({ length: 7 }, (_, index) => String(index).repeat(64));
  const activeTmp = `.tmp-${key}-active`;
  const candidates: Array<[string, number]> = [
    ...entries.map((entry, index): [string, number] => [entry, (index + 1) * 1_000]),
    ["e".repeat(64), 31 * 24 * 60 * 60 * 1_000],
    [`.tmp-${key}-crashed`, 3_600_001],
    [activeTmp, 10_000],
  ];
  for (const [entry, elapsed] of candidates) {
    const dir = path.join(seeds, entry);
    await fsp.mkdir(dir);
    await age(dir, elapsed);
  }
  await seed("store");
  expect((await fsp.readdir(seeds)).toSorted()).toEqual(
    [activeTmp, ...entries.slice(0, 5), key].toSorted(),
  );
});

it.each(["apply", "store"] as const)(
  "rejects a symlinked seed on %s without touching its target",
  async (action) => {
    const outside = path.join(home, "outside");
    await fsp.mkdir(outside);
    await write("marker", "untouched", outside);
    await fsp.mkdir(seeds, { recursive: true });
    await fsp.symlink(outside, path.join(seeds, key), "dir");
    await expect(seed(action)).rejects.toThrow("seed");
    expect(await fsp.readFile(path.join(outside, "marker"), "utf8")).toBe("untouched");
  },
);

it("rejects a store without an existing source workspace", async () => {
  await fsp.rm(workspace, { recursive: true });
  await expect(seed("store")).rejects.toThrow("workspace seed source");
  await expect(fsp.stat(path.join(seeds, key))).rejects.toMatchObject({ code: "ENOENT" });
});

it("serializes competing stores of the same repository across sessions", async () => {
  await write("tracked.txt", "first");
  await write("tracked.txt", "second", (await exec(["node", "-e", ""], "session-2")).workspaceDir);
  const results = await Promise.all([seed("store"), seed("store", "session-2")]);
  expect(results.map((result) => result.stdout).toSorted()).toEqual(["fresh\n", "stored\n"]);
  expect(await fsp.readdir(seeds)).toEqual([key]);
});
