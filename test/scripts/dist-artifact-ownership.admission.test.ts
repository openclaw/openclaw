import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
} from "../../scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
afterEach(() => vi.restoreAllMocks());

function checkout() {
  const root = temporary.make("dist-admission-");
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

it.each(["live", "dead"])(
  "refuses a %s retained owner without changing its record",
  async (kind) => {
    const root = checkout();
    const directory = resolveDistArtifactLockPath(root);
    fs.mkdirSync(directory, { recursive: true });
    const pid = kind === "live" ? process.pid : 2147483647;
    const startedAt = "2026-09-25T10:00:00.000Z";
    const heartbeatAt = "2026-09-25T10:01:00.000Z";
    const record = JSON.stringify({ pid, startedAt, heartbeatAt });
    const ownerPath = path.join(directory, "owner.json");
    fs.writeFileSync(ownerPath, record);
    if (kind === "dead") {
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((candidate, signal) => {
        if (candidate === pid) {
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        }
        return kill(candidate, signal);
      });
    }
    const failure = await acquireDistArtifactOwnership(root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(`retained by PID ${pid}`);
    expect(String(failure)).toContain(startedAt);
    expect(String(failure)).toContain(`last seen "${heartbeatAt}"`);
    expect(String(failure)).toContain(directory);
    expect(String(failure)).toContain("PID death alone is not sufficient.");
    expect(fs.readFileSync(ownerPath, "utf8")).toBe(record);
  },
);

it("retains admitted ownership until release and excludes unrelated callers in the same process", async () => {
  const root = checkout();
  const ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  const owner = await acquireDistArtifactOwnership(root);
  try {
    const record = fs.readFileSync(ownerPath, "utf8");
    await expect(acquireDistArtifactOwnership(root)).rejects.toThrow("Could not acquire");
    await owner.assertOwned();
    expect(fs.readFileSync(ownerPath, "utf8")).toBe(record);
  } finally {
    await owner.release();
  }
  await owner.release();
  expect(fs.existsSync(ownerPath)).toBe(false);
  await expect(owner.assertOwned()).rejects.toThrow("Could not acquire");
});

it("revokes admitted publication if the recorded owner is replaced", async () => {
  const root = checkout();
  const ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  const owner = await acquireDistArtifactOwnership(root);
  const replacement = JSON.stringify({ pid: process.pid, startedAt: "replacement" });
  fs.writeFileSync(ownerPath, replacement);
  await expect(owner.assertOwned()).rejects.toThrow("Could not acquire");
  await owner.release();
  expect(fs.readFileSync(ownerPath, "utf8")).toBe(replacement);
});

it("delegates native completion under retained ownership and honors a replaced legacy entry adapter", async ({
  signal,
}) => {
  await lifetime.run(async () => {
    const root = lifetime.createTempDir("dist-admission-child-");
    fs.mkdirSync(path.join(root, ".git"));
    const scripts = path.join(root, "scripts");
    fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "stage-bundled-plugin-runtime.mts"), "export {};\n");
    const library = path.join(scripts, "lib");
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    for (const relative of [
      "scripts/lib/dist-artifact-ownership.mts",
      "scripts/lib/dist-artifact-lock.mts",
      "scripts/lib/direct-run.mjs",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/repo-root.mjs",
      "scripts/lib/vitest-resource-ownership.mts",
      "scripts/lib/windows-taskkill.mjs",
      "scripts/windows-cmd-helpers.mjs",
      "src/infra/windows-process-start.ts",
      "src/infra/process-env.ts",
    ]) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, relative), destination);
    }
    fs.mkdirSync(path.join(root, "node_modules/@openclaw"), { recursive: true });
    fs.symlinkSync(
      path.join(sourceRoot, "node_modules/@openclaw/fs-safe"),
      path.join(root, "node_modules/@openclaw/fs-safe"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const adapter = path.join(library, "dist-artifact-ownership.mts");
    const directory = resolveDistArtifactLockPath(root);
    const ownerPath = path.join(directory, "owner.json");
    const completed = path.join(root, "completion.json");
    const child = path.join(root, "completion.mts");
    fs.writeFileSync(
      child,
      `import fs from 'node:fs';
import { withDistArtifactOwnership } from ${JSON.stringify(pathToFileURL(adapter).href)};
void (async () => {
  await fs.promises.readFile(${JSON.stringify(ownerPath)}, 'utf8');
  await withDistArtifactOwnership(process.cwd(), async () => {
    fs.writeFileSync(${JSON.stringify(completed)}, JSON.stringify({
      pid: process.pid,
      owner: fs.readFileSync(${JSON.stringify(ownerPath)}, 'utf8'),
      args: process.argv.slice(2),
    }));
  });
  process.exit(0);
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    );
    const owner = await acquireDistArtifactOwnership(root, { runtimeChildren: true });
    const record = fs.readFileSync(ownerPath, "utf8");
    const runChild = async (argument: string, retainsClaim = true) => {
      const output = createBoundedChildOutput();
      const exitCode = await lifetime.track(
        runManagedCommand({
          bin: resolveTestNodeExecPath(),
          args: await owner.entryArgs(child, [argument]),
          cwd: root,
          signal,
          stdio: ["ignore", "pipe", "pipe"],
          requireProcessTreeExit: true,
          onReady(process) {
            process.stdout?.on("data", output.append);
            process.stderr?.on("data", output.append);
          },
        }),
      );
      expect(exitCode, output.text()).toBe(0);
      const result = JSON.parse(fs.readFileSync(completed, "utf8"));
      expect(result).toEqual({
        pid: expect.any(Number),
        owner: record,
        args: [argument],
      });
      await owner.assertOwned();
      expect(fs.readFileSync(ownerPath, "utf8")).toBe(record);
      expect(fs.existsSync(path.join(directory, `child-${result.pid}`))).toBe(retainsClaim);
      await owner.completeChild(result.pid);
      expect(fs.readdirSync(directory).filter((name) => name.startsWith("child-"))).toEqual([]);
    };
    try {
      await runChild("native completion");

      // Exact shipped owner source: its private entry clears inheritance when
      // import returns. The bridge must preserve it through void worker startup.
      fs.copyFileSync(
        path.join(import.meta.dirname, "fixtures/dist-artifact-ownership-2026.9.5.mts.txt"),
        adapter,
      );
      // This workload is native TypeScript and needs no loader transformation.
      fs.writeFileSync(path.join(scripts, "tsx.mjs"), "export {};\n");
      fs.writeFileSync(
        child,
        `import fs from 'node:fs';
import { withDistArtifactOwnership } from ${JSON.stringify(pathToFileURL(adapter).href)};
void (async () => {
  await fs.promises.readFile(${JSON.stringify(ownerPath)}, 'utf8');
  await withDistArtifactOwnership(process.cwd(), async () => {
    fs.writeFileSync(${JSON.stringify(completed)}, JSON.stringify({
      pid: process.pid,
      owner: fs.readFileSync(${JSON.stringify(ownerPath)}, 'utf8'),
      args: process.argv.slice(2),
    }));
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
      );
      await runChild("legacy asynchronous completion", false);
      fs.appendFileSync(child, "\nprocess.once('beforeExit', () => process.exit(0));\n");
      await runChild("legacy explicit exit completion");

      fs.unlinkSync(adapter);
      const staging = path.join(scripts, "stage-bundled-plugin-runtime.mts");
      fs.writeFileSync(staging, "export function stageBundledPluginRuntime() {}\n");
      fs.writeFileSync(
        child,
        `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(completed)}, JSON.stringify({
  pid: process.pid,
  owner: fs.readFileSync(${JSON.stringify(ownerPath)}, 'utf8'),
  args: process.argv.slice(2),
}));
process.exit(0);
`,
      );
      await runChild("legacy stager without ownership adapter", false);
      for (const exports of [
        "export function stageBundledPluginRuntime() {} export function prepareBundledPluginRuntime() {}",
        "export const stageBundledPluginRuntime = false;",
      ]) {
        fs.writeFileSync(staging, exports);
        await expect(owner.entryArgs(child)).rejects.toThrow("ENOENT");
        await owner.assertOwned();
      }
      const unknown = path.join(directory, "child-2147483647");
      fs.writeFileSync(unknown, "unrecognized retained work");
      await expect(owner.completeChild(2147483647)).rejects.toThrow("Could not acquire");
      expect(fs.readFileSync(unknown, "utf8")).toBe("unrecognized retained work");
      fs.unlinkSync(unknown);
    } finally {
      await owner.release();
    }
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
