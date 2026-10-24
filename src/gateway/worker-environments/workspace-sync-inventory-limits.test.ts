import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { workspaceStatIdentity } from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";
import {
  createScriptWorkspace,
  initializeScriptGitWorkspace,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const manifestWorkspace = async () =>
  createScriptWorkspace(await fs.realpath(tempDirs.make("openclaw-manifest-")));

async function gitWorkspace() {
  const fixture = await manifestWorkspace();
  const { workspace } = fixture;
  await fs.writeFile(path.join(workspace, ".gitignore"), "");
  const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");
  return { ...fixture, baseCommit };
}

it.each([
  { firstSize: 8, secondSize: 11, cached: true, accepted: true },
  { firstSize: 8, secondSize: 12, cached: true, accepted: false },
  { firstSize: 12, secondSize: 7, cached: false, accepted: true },
])(
  "budgets opened files ($firstSize + $secondSize) and symlink bytes with cached=$cached",
  async ({ firstSize, secondSize, cached, accepted }) => {
    const { root, workspace, manifestRoot, readManifest, runScript } = await manifestWorkspace();
    const first = path.join(workspace, "a.txt");
    const second = path.join(workspace, "b.txt");
    const auditPath = path.join(root, "handles.json");
    const contents = Buffer.alloc(8, 65);
    await Promise.all([fs.writeFile(first, contents), fs.writeFile(second, contents)]);
    await fs.symlink("a.txt", path.join(workspace, "link"));
    const digest = createHash("sha256").update(contents).digest("hex");
    const memo = cached
      ? [[workspaceStatIdentity("worker", await fs.stat(first, { bigint: true })), digest]]
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
    const result = await runScript(prelude + script)(["", "all", "memo-v1"], {
      input: JSON.stringify(memo),
    });
    expect(JSON.parse(await fs.readFile(auditPath, "utf8"))).toEqual([true, true]);
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
    const manifest = await readManifest(response.manifestRef);
    expect(manifest.entries).toEqual([
      expect.objectContaining({ path: "a.txt", type: "file", size: firstSize }),
      expect.objectContaining({ path: "b.txt", type: "file", size: secondSize }),
      expect.objectContaining({ path: "link", type: "symlink", target: "a.txt" }),
    ]);
  },
);

it("stops hashing a growing file at its opened size and settles its stream and handle", async () => {
  const { root, workspace, manifestRoot, runScript } = await manifestWorkspace();
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
  const result = await runScript(prelude + REMOTE_WORKSPACE_MANIFEST_JS)();
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
  expect(await fs.readdir(manifestRoot)).toEqual([]);
});

it.each([
  ["full workspace above 4 GiB", "eligible byte limit"],
  ["prior manifest above the entry limit", "invalid prior workspace manifest"],
])("rejects a %s", async (kind, message) => {
  const { workspace, baseCommit, manifestRoot, runManifest } = await gitWorkspace();
  const args = [baseCommit, "eligible"];
  if (kind.startsWith("full")) {
    const oversized = path.join(workspace, "oversized.bin");
    await fs.writeFile(oversized, "");
    await fs.truncate(oversized, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);
  } else {
    await fs.mkdir(manifestRoot, { recursive: true });
    const raw = JSON.stringify({
      version: 1,
      baseCommit: null,
      entries: Array.from({ length: MAX_WORKSPACE_INVENTORY_ENTRIES + 1 }, () => null),
    });
    const digest = createHash("sha256").update(raw).digest("hex");
    await fs.writeFile(path.join(manifestRoot, digest + ".json"), raw);
    args.push(digest);
  }
  const result = await runManifest(args);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(message);
});

it("budgets raw Git candidates separately from materialized eligible inventory", async () => {
  expect(MAX_WORKSPACE_GIT_CANDIDATES).toBe(4 * MAX_WORKSPACE_INVENTORY_ENTRIES);
  const { home, baseCommit, runManifest: run, readManifest } = await gitWorkspace();
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

  const accepted = await run([baseCommit, "eligible"], { timeoutMs: 20_000, baseEnv });
  expect(accepted.code, accepted.stderr).toBe(0);
  const manifestRef = accepted.stdout.trim();
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const manifest = await readManifest(manifestRef);
  expect(manifest.entries).toEqual([]);

  const rejected = await run([baseCommit, "eligible"], {
    timeoutMs: 20_000,
    baseEnv: {
      ...baseEnv,
      OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_GIT_CANDIDATES + 1),
    },
  });
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("too many Git path candidates");
}, 30_000);
