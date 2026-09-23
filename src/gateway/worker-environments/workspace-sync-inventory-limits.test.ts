import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { workspaceStatIdentity } from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function manifestWorkspace(name: string) {
  const root = await fs.realpath(tempDirs.make(`${name}-`));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
  return { root, home, workspace };
}

async function gitWorkspace(name: string) {
  const { home, workspace } = await manifestWorkspace(name);
  await fs.writeFile(path.join(workspace, ".gitignore"), "");
  for (const args of [
    ["init", "--quiet"],
    ["add", ".gitignore"],
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@openclaw.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ],
  ]) {
    expect(
      await runCommandWithTimeout(["git", "-C", workspace, ...args], { timeoutMs: 10_000 }),
    ).toMatchObject({ code: 0 });
  }
  const baseCommit = (
    await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
      timeoutMs: 10_000,
    })
  ).stdout.trim();
  return { home, workspace, baseCommit };
}

it.each([
  { firstSize: 8, secondSize: 11, cached: true, accepted: true },
  { firstSize: 8, secondSize: 12, cached: true, accepted: false },
  { firstSize: 12, secondSize: 7, cached: false, accepted: true },
])(
  "budgets opened files ($firstSize + $secondSize) and symlink bytes with cached=$cached",
  async ({ firstSize, secondSize, cached, accepted }) => {
    const { root, home, workspace } = await manifestWorkspace("openclaw-manifest-open-budget");
    const first = path.join(workspace, "a.txt");
    const second = path.join(workspace, "b.txt");
    const auditPath = path.join(root, "handles.json");
    const contents = Buffer.alloc(8, 65);
    await Promise.all([fs.writeFile(first, contents), fs.writeFile(second, contents)]);
    await fs.symlink("a.txt", path.join(workspace, "link"));
    const memo = cached
      ? [
          [
            workspaceStatIdentity("worker", await fs.stat(first, { bigint: true })),
            createHash("sha256").update(contents).digest("hex"),
          ],
        ]
      : [];
    // Keep real descriptors and hashing; resize only after inventory, at open.
    const prelude = String.raw`{
      const io = require("node:fs");
      const sizes = new Map(${JSON.stringify([
        [first, firstSize],
        [second, secondSize],
      ])});
      const handles = [];
      const open = io.promises.open.bind(io.promises);
      io.promises.open = async (...args) => {
        const size = sizes.get(args[0]);
        if (size !== undefined && io.statSync(args[0]).size !== size) {
          io.truncateSync(args[0], size);
        }
        const handle = await open(...args);
        if (size !== undefined) handles.push(handle);
        return handle;
      };
      process.once("exit", () => io.writeFileSync(
        ${JSON.stringify(auditPath)}, JSON.stringify(handles.map((handle) => handle.fd === -1)),
      ));
    }
    `;
    // Scale the existing limit so this race uses bytes, not GiB of I/O.
    const script = REMOTE_WORKSPACE_MANIFEST_JS.replace(
      `const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES};`,
      "const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = 24;",
    );
    expect(script).not.toBe(REMOTE_WORKSPACE_MANIFEST_JS);
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", prelude + script, workspace, "", "all", "memo-v1"],
      { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home }, input: JSON.stringify(memo) },
    );
    expect(JSON.parse(await fs.readFile(auditPath, "utf8"))).toEqual([true, true]);
    const manifestRoot = path.join(home, ".openclaw-worker", "manifests");
    if (!accepted) {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("eligible byte limit");
      expect(result.stdout).toBe("");
      expect(await fs.readdir(manifestRoot)).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = JSON.parse(result.stdout) as {
      manifestRef: string;
      metrics: { contentHashCount: number; memoHitCount: number };
    };
    expect(response.metrics).toMatchObject({
      contentHashCount: cached ? 1 : 2,
      memoHitCount: cached ? 1 : 0,
    });
    const manifest = JSON.parse(
      await fs.readFile(path.join(manifestRoot, `${response.manifestRef.slice(7)}.json`), "utf8"),
    ) as { entries: Array<{ path: string; type: string; size?: number; target?: string }> };
    expect(manifest.entries).toEqual([
      expect.objectContaining({ path: "a.txt", type: "file", size: firstSize }),
      expect.objectContaining({ path: "b.txt", type: "file", size: secondSize }),
      expect.objectContaining({ path: "link", type: "symlink", target: "a.txt" }),
    ]);
  },
);

it("stops hashing a growing file at its opened size and settles its stream and handle", async () => {
  const { root, home, workspace } = await manifestWorkspace("openclaw-manifest-stream-budget");
  const target = path.join(workspace, "growing.txt");
  const auditPath = path.join(root, "stream.json");
  await fs.writeFile(target, "12345678");
  const prelude = String.raw`{
    const io = require("node:fs");
    const crypto = require("node:crypto");
    const target = ${JSON.stringify(target)};
    const audit = { consumed: 0, hashed: 0, grew: false, streamClosed: false };
    let opened;
    let reading;
    const createHash = crypto.createHash.bind(crypto);
    crypto.createHash = (...args) => {
      const hash = createHash(...args);
      const update = hash.update.bind(hash);
      hash.update = (chunk, ...options) => {
        audit.hashed += chunk.length;
        return update(chunk, ...options);
      };
      return hash;
    };
    const open = io.promises.open.bind(io.promises);
    io.promises.open = async (...args) => {
      const handle = await open(...args);
      if (args[0] !== target) return handle;
      opened = handle;
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        const stream = createReadStream({ ...options, highWaterMark: 2 });
        reading = stream;
        stream.on("data", (chunk) => {
          audit.consumed += chunk.length;
          if (!audit.grew) {
            audit.grew = true;
            io.appendFileSync(target, Buffer.alloc(64));
          }
        });
        stream.once("close", () => { audit.streamClosed = true; });
        return stream;
      };
      return handle;
    };
    process.once("exit", () => io.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
      ...audit, handleClosed: opened.fd === -1, streamDestroyed: reading.destroyed,
    })));
  }
  `;
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", prelude + REMOTE_WORKSPACE_MANIFEST_JS, workspace],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("file changed while it was being read");
  expect(result.stdout).toBe("");
  const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as {
    consumed: number;
    hashed: number;
  };
  expect(audit).toMatchObject({
    grew: true,
    handleClosed: true,
    streamClosed: true,
    streamDestroyed: true,
  });
  expect(audit.consumed).toBeLessThan(72);
  expect(audit.hashed).toBeLessThanOrEqual(8);
  expect((await fs.stat(target)).size).toBe(72);
  expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
});

it("rejects a full workspace above 4 GiB before hashing its files", async () => {
  const { home, workspace, baseCommit } = await gitWorkspace("openclaw-manifest-byte-budget");
  const oversizedPath = path.join(workspace, "oversized.bin");
  await fs.writeFile(oversizedPath, "");
  await fs.truncate(oversizedPath, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);

  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("eligible byte limit");
});

it("rejects prior manifests above the full-inventory entry limit", async () => {
  const { home, workspace, baseCommit } = await gitWorkspace("openclaw-manifest-entry-budget");
  const manifestRoot = path.join(home, ".openclaw-worker", "manifests");
  await fs.mkdir(manifestRoot, { recursive: true });
  const priorRaw = JSON.stringify({
    version: 1,
    baseCommit: null,
    entries: Array.from({ length: MAX_WORKSPACE_INVENTORY_ENTRIES + 1 }, () => null),
  });
  const priorDigest = createHash("sha256").update(priorRaw).digest("hex");
  await fs.writeFile(path.join(manifestRoot, `${priorDigest}.json`), priorRaw);

  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_MANIFEST_JS,
      workspace,
      baseCommit,
      "eligible",
      priorDigest,
    ],
    { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("invalid prior workspace manifest");
});

it("budgets raw Git candidates separately from materialized eligible inventory", async () => {
  expect(MAX_WORKSPACE_GIT_CANDIDATES).toBe(4 * MAX_WORKSPACE_INVENTORY_ENTRIES);
  const { home, workspace, baseCommit } = await gitWorkspace("openclaw-raw-git-candidate-budget");
  const bin = path.join(home, "bin");
  const mockGit = path.join(bin, "git");
  await fs.mkdir(bin);
  await fs.writeFile(
    mockGit,
    `#!/usr/bin/env node
const count = Number(process.env.OPENCLAW_TEST_GIT_CANDIDATES);
process.stdout.write("missing\\0".repeat(count));
`,
    { mode: 0o755 },
  );
  const baseEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_INVENTORY_ENTRIES + 1),
  };

  const accepted = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
    { timeoutMs: 20_000, baseEnv },
  );
  expect(accepted.code, accepted.stderr).toBe(0);
  const manifestRef = accepted.stdout.trim();
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${manifestRef.slice(7)}.json`),
      "utf8",
    ),
  );
  expect(manifest.entries).toEqual([]);

  const rejected = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
    {
      timeoutMs: 20_000,
      baseEnv: {
        ...baseEnv,
        OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_GIT_CANDIDATES + 1),
      },
    },
  );
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("too many Git path candidates");
}, 30_000);
