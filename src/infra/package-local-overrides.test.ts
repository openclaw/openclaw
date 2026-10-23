import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  expectPathMissing,
  useLocalOverrideTestState,
} from "./package-local-overrides.test-support.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";

useLocalOverrideTestState();
const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let packageRoot: string;
let distPath: string;
let indexPath: string;

beforeEach(async () => {
  base = dirs.make("openclaw-package-local-overrides-");
  packageRoot = path.join(base, "package");
  distPath = path.join(packageRoot, "dist");
  indexPath = path.join(distPath, "index.js");
  await writePackageRoot(packageRoot, "1.0.0");
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const writeLocal = (file = indexPath) => fs.writeFile(file, "export const local = true;\n", "utf8");
const expectContent = (file: string, content: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(content);
const inspect = () => captureLocalPackageOverrides({ packageRoot });
async function capture() {
  const plan = await inspect();
  expect(plan).not.toBeNull();
  return plan;
}
const reapply = (plan: Awaited<ReturnType<typeof capture>>) =>
  applyLocalPackageOverrides({ packageRoot, plan, reapply: true });
function expectOutcome(
  result: Awaited<ReturnType<typeof reapply>>,
  status: "conflict" | "error" | "applied",
  applied = 0,
) {
  expect(result).toMatchObject({ status, applied });
}
function expectConflict(
  result: Awaited<ReturnType<typeof reapply>>,
  file: string,
  reason = "target-inspection-failed",
) {
  expectOutcome(result, "conflict");
  expect(result.conflicts).toEqual([{ path: file, reason }]);
}
async function prepareReplay(
  kind: "modified" | "deleted" | "added",
  file = indexPath,
  update = true,
) {
  if (kind === "deleted") {
    await fs.rm(file);
  } else {
    await writeLocal(file);
  }
  const plan = await capture();
  if (update) {
    await writePackageRoot(packageRoot, "2.0.0");
    if (kind === "added") {
      await fs.rm(file);
      await writePackageDistInventory(packageRoot);
    }
  }
  return plan;
}

function onRollback(action: () => Promise<void>, afterCreation = false) {
  const mkdtemp = fs.mkdtemp.bind(fs);
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    const targeted = prefix.endsWith(`${path.sep}rollback-`);
    if (targeted && !afterCreation) {
      await action();
    }
    const result = await mkdtemp(prefix, options);
    if (targeted && afterCreation) {
      await action();
    }
    return result;
  });
}

function onDistInspection(action: () => Promise<void>, afterStaging = false) {
  const realpath = fs.realpath.bind(fs);
  let changed = false;
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args);
    if (!changed && String(args[0]) === distPath) {
      const entries = afterStaging ? await fs.readdir(distPath).catch(() => [] as string[]) : [];
      if (!afterStaging || entries.some((entry) => entry.startsWith(".openclaw-override-next-"))) {
        changed = true;
        await action();
      }
    }
    return result;
  });
  return () => expect(changed).toBe(true);
}

it("rejects recovery roots inside the package being updated", async () => {
  await writeLocal();
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(packageRoot, "state"));
  await expect(inspect()).rejects.toThrow(
    "local override recovery root must be outside package root",
  );
  await expectPathMissing(path.join(packageRoot, "state"));
});

it("does not classify baseline files replaced by directories as deletions", async () => {
  await fs.rm(indexPath);
  await fs.mkdir(indexPath);
  await expect(inspect()).rejects.toMatchObject({ code: "not-file" });
  expect((await fs.stat(indexPath)).isDirectory()).toBe(true);
});

async function checkAddedTopology(phase: "preflight" | "publication" | "root") {
  const relative = phase === "preflight" ? "dist/local/added.js" : "dist/local.js";
  const added = path.join(packageRoot, relative);
  const rootChanged = phase === "root";
  const outside = path.join(base, rootChanged ? "replacement" : "outside");
  const preserved =
    phase === "root" ? path.join(base, "preserved") : path.join(packageRoot, "preserved-dist");
  await fs.mkdir(path.dirname(added), { recursive: true });
  const plan = await prepareReplay("added", added, phase !== "preflight");
  if (rootChanged) {
    await writePackageRoot(outside, "2.0.0");
  } else {
    await fs.mkdir(outside, { recursive: true });
  }
  const swap = async () => {
    if (phase === "preflight") {
      await fs.rm(distPath, { recursive: true, force: true });
    } else {
      await fs.rename(rootChanged ? packageRoot : distPath, preserved);
    }
    if (rootChanged) {
      await fs.rename(outside, packageRoot);
    } else {
      await fs.symlink(outside, distPath, "dir");
    }
  };
  let expectSwap: (() => void) | undefined;
  if (phase === "preflight") {
    await swap();
  } else {
    expectSwap = onDistInspection(swap, phase === "publication");
  }
  const result = await reapply(plan);
  expectSwap?.();
  if (phase === "publication") {
    expectOutcome(result, "error");
  } else {
    expectConflict(result, relative);
  }
  const untouched = rootChanged
    ? [added, path.join(preserved, relative)]
    : [path.join(outside, path.relative(distPath, added))];
  for (const file of untouched) {
    await expectPathMissing(file);
  }
}
it.runIf(process.platform !== "win32").each(["preflight", "publication"] as const)(
  "refuses added override topology changes at %s",
  checkAddedTopology,
);
it("refuses a changed package root for added overrides", () => checkAddedTopology("root"));

it.runIf(process.platform !== "win32")(
  "rejects a deleted override's swapped ancestor",
  async () => {
    const redirectRoot = path.join(base, "outside");
    const redirectIndexPath = path.join(redirectRoot, "index.js");
    const redirectAddedPath = path.join(redirectRoot, "local.js");
    const plan = await prepareReplay("deleted");
    await fs.mkdir(redirectRoot, { recursive: true });
    await fs.writeFile(redirectIndexPath, "export const redirect = true;\n", "utf8");
    onRollback(async () => {
      await fs.rm(distPath, { recursive: true, force: true });
      await fs.symlink(redirectRoot, distPath, "dir");
    });
    const result = await reapply(plan);
    expectOutcome(result, "error");
    await expectContent(redirectIndexPath, "export const redirect = true;\n");
    await expectPathMissing(redirectAddedPath);
  },
);

it.runIf(process.platform !== "win32").each(["source-ancestor", "replay-target"] as const)(
  "does not follow a swapped %s symlink",
  async (boundary) => {
    const outside = path.join(base, "outside");
    const outsideIndex = path.join(outside, "index.js");
    const preserved = path.join(packageRoot, "preserved-dist");
    await writeLocal();
    await fs.mkdir(outside);
    await fs.writeFile(outsideIndex, "export const outside = true;\n", "utf8");
    const plan = boundary === "replay-target" ? await capture() : null;
    if (plan) {
      await writePackageRoot(packageRoot, "2.0.0");
    }
    const realIndex = await fs.realpath(indexPath);
    let changed = false;
    __setFsSafeTestHooksForTest({
      afterPreOpenLstat: async (file) => {
        const targeted =
          boundary === "source-ancestor"
            ? path.basename(file) === path.basename(indexPath)
            : file === realIndex;
        if (!changed && targeted) {
          changed = true;
          if (boundary === "source-ancestor") {
            await fs.rename(distPath, preserved);
            await fs.symlink(outside, distPath, "dir");
          } else {
            await fs.rm(indexPath);
            await fs.symlink(outsideIndex, indexPath, "file");
          }
        }
      },
    });
    if (boundary === "source-ancestor") {
      await expect(inspect()).rejects.toMatchObject({
        code: expect.stringMatching(/outside-workspace|path-mismatch|symlink/),
      });
    } else {
      const result = await reapply(plan);
      expectConflict(result, "dist/index.js");
    }
    expect(changed).toBe(true);
    await expectContent(outsideIndex, "export const outside = true;\n");
  },
);

it.runIf(process.platform !== "win32").each(["executable", "non-executable"] as const)(
  "handles %s upstream mode changes",
  async (kind) => {
    await fs.chmod(indexPath, 0o644);
    await writePackageDistInventory(packageRoot);
    if (kind === "non-executable") {
      await fs.chmod(indexPath, 0o600);
      await expect(inspect()).resolves.toBeNull();
      return;
    }
    await fs.rm(indexPath);
    const plan = await capture();
    await fs.writeFile(indexPath, "export {};\n", "utf8");
    await fs.chmod(indexPath, 0o755);
    await writePackageDistInventory(packageRoot);
    const result = await reapply(plan);
    expectConflict(result, "dist/index.js", "target-changed");
    await expectContent(indexPath, "export {};\n");
    expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
  },
);

it("captures and reapplies locally added files excluded from package files", async () => {
  const localFiles = new Map([
    ["dist/index.js.map", '{"version":3,"sources":["index.ts"]}\n'],
    ["dist/local-runtime.js", "export const local = true;\n"],
    ["dist/local-assets/theme.css", "body {}\n"],
    ["dist/local-assets/runtime.wasm", "local wasm\n"],
    ["dist/local-assets/settings.json", '{"local":true}\n'],
  ]);
  const files = ["dist/", "!dist/**/*.map", "!dist/local-runtime.js", "!dist/local-assets/**"];
  const writePackageJson = (version: string) =>
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version, files }),
      "utf8",
    );
  await writePackageJson("1.0.0");
  await writePackageDistInventory(packageRoot);
  for (const [relativePath, content] of localFiles) {
    const filePath = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
  const plan = await capture();
  expect(plan?.result.added).toBe(localFiles.size);
  await writePackageRoot(packageRoot, "2.0.0");
  await writePackageJson("2.0.0");
  for (const relativePath of localFiles.keys()) {
    await fs.rm(path.join(packageRoot, relativePath));
  }
  await writePackageDistInventory(packageRoot);
  const stat = vi.spyOn(fs, "stat");
  const result = await reapply(plan);
  expectOutcome(result, "applied", localFiles.size);
  for (const change of plan?.changes ?? []) {
    if (change.kind !== "deleted") {
      expect(stat.mock.calls.some(([file]) => file === change.savedPath)).toBe(false);
    }
  }
  for (const [relativePath, content] of localFiles) {
    await expect(fs.readFile(path.join(packageRoot, relativePath), "utf8")).resolves.toBe(content);
  }
});

async function checkConcurrentChange(
  phase: "unrecorded" | "preflight" | "replacement" | "deletion-cleanup",
) {
  const plan = await prepareReplay(
    phase === "deletion-cleanup" ? "deleted" : "modified",
    indexPath,
    phase !== "unrecorded",
  );
  if (phase === "unrecorded") {
    await fs.writeFile(indexPath, "export {};\n", "utf8");
    await writePackageDistInventory(packageRoot);
  }
  const bytes = "export const concurrent = true;\n";
  const change = vi.fn(() => fs.writeFile(indexPath, bytes, "utf8"));
  if (phase === "unrecorded") {
    await change();
  } else if (phase === "preflight") {
    onRollback(async () => {
      if (!change.mock.calls.length) {
        await change();
      }
    }, true);
  } else if (phase === "replacement") {
    onDistInspection(change, true);
  } else {
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, target) => {
        if (
          !change.mock.calls.length &&
          operation === "remove" &&
          path.basename(target).startsWith(".openclaw-override-previous-")
        ) {
          await change();
        }
      },
    });
  }
  const result = await reapply(plan);
  expect(change).toHaveBeenCalledOnce();
  if (phase === "unrecorded") {
    expectConflict(result, "dist/index.js", "target-changed");
  } else {
    expectOutcome(result, "error");
  }
  await expectContent(indexPath, bytes);
  if (phase === "replacement") {
    expect(
      (await fs.readdir(distPath)).filter((entry) => entry.startsWith(".openclaw-override-")),
    ).toEqual([]);
  }
}
it.each(["unrecorded", "replacement", "deletion-cleanup"] as const)(
  "preserves concurrent bytes during %s",
  checkConcurrentChange,
);
it.runIf(process.platform !== "win32")("preserves concurrent bytes after preflight", () =>
  checkConcurrentChange("preflight"),
);

it("treats deletions already satisfied by the updated package as a no-op", async () => {
  const plan = await prepareReplay("deleted");
  await fs.rm(indexPath);
  await writePackageDistInventory(packageRoot);
  const result = await reapply(plan);
  expectOutcome(result, "applied");
  expect(result.conflicts).toEqual([]);
  await expectPathMissing(indexPath);
});
