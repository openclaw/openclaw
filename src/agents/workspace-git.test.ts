import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as directoryObservation from "../infra/owned-directory-observation.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { ensureGitRepo, findGitCheckoutRoot, hasWorkspaceGitCheckout } from "./workspace-git.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("node:fs") & { default: typeof import("node:fs") }
  >();
  const overrides = {
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
  return { ...actual, ...overrides, default: { ...actual.default, ...overrides } };
});

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("shared-state");
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refreshes workspace Git presentation after external metadata changes", async () => {
  const workspace = tempDirs.make("workspace-git-projection-");
  const metadata = path.join(workspace, ".git");
  expect(await findGitCheckoutRoot(workspace)).toBeNull();
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);

  await promisify(execFile)(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'gitdir: missing-worktree\\n')",
    metadata,
  ]);
  expect(await findGitCheckoutRoot(workspace)).toBe(workspace);
  await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(true));

  await promisify(execFile)(process.execPath, [
    "-e",
    "require('node:fs').unlinkSync(process.argv[1])",
    metadata,
  ]);
  expect(await findGitCheckoutRoot(workspace)).toBeNull();
  await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(false));

  await ensureGitRepo(workspace, true);
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
});

it("caches workspace Git presentation between observation invalidations", async () => {
  const workspace = tempDirs.make("workspace-git-cache-");
  const listeners: Parameters<typeof directoryObservation.observeOwnedDirectory>[1][] = [];
  // Native registration may finish after the first read; control that notification for work counts.
  vi.spyOn(directoryObservation, "observeOwnedDirectory").mockImplementation(
    (_directory, listener) => {
      listeners.push(listener);
      return { close() {}, isWatching: () => true };
    },
  );
  const stat = vi.spyOn(fsPromises, "stat");
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);
  expect(stat).toHaveBeenCalled();

  await fsPromises.writeFile(path.join(workspace, ".git"), "gitdir: missing-worktree\n");
  expect(await findGitCheckoutRoot(workspace)).toBe(workspace);
  stat.mockClear();
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);
  expect(stat).not.toHaveBeenCalled();

  for (const listener of listeners) {
    listener(undefined, "change");
  }
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
  expect(stat).toHaveBeenCalled();
  stat.mockClear();
  for (let i = 0; i < 10; i++) {
    expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
  }
  expect(stat).not.toHaveBeenCalled();

  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  for (const listener of listeners) {
    listener();
  }
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
  expect(stat).not.toHaveBeenCalled();
});

it("keeps periodic presentation and fresh admission off synchronous filesystem APIs", async () => {
  const workspace = tempDirs.make("workspace-git-main-thread-");
  await fs.promises.writeFile(path.join(workspace, ".git"), "gitdir: missing-worktree\n");
  await hasWorkspaceGitCheckout(workspace);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const sync = [
    vi.mocked(fs.existsSync).mockClear(),
    vi.mocked(fs.statSync).mockClear(),
    vi.mocked(fs.lstatSync).mockClear(),
    vi.mocked(fs.readdirSync).mockClear(),
  ];
  for (let i = 0; i < 10; i++) {
    expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
    expect(await findGitCheckoutRoot(workspace)).toBe(workspace);
  }
  for (const call of sync) {
    expect(call).not.toHaveBeenCalled();
  }
});

it.for(["native", "named-change"] as const)(
  "invalidates nested checkout presentation when an ancestor alias or Git marker changes (%s)",
  async (delivery, { signal }) => {
    const root = tempDirs.make("workspace-git-alias-");
    const repository = path.join(root, "repository");
    const plain = path.join(root, "plain");
    const alias = path.join(root, "alias");
    await fs.promises.mkdir(path.join(repository, "nested"), { recursive: true });
    await fs.promises.mkdir(path.join(plain, "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(repository, ".git"), "gitdir: missing-worktree\n");
    await fs.promises.symlink(repository, alias, "junction");
    const workspace = path.join(alias, "nested");
    const metadataListeners: Parameters<typeof directoryObservation.observeOwnedDirectory>[1][] =
      [];
    let controlled = false;
    let expected: (PromiseWithResolvers<void> & { value: boolean }) | undefined;
    const observe = directoryObservation.observeOwnedDirectory;
    vi.spyOn(directoryObservation, "observeOwnedDirectory").mockImplementation(
      (directory, listener, options) => {
        if (directory === path.join(root, ".git")) {
          metadataListeners.push(listener);
        }
        return observe(
          directory,
          (filename, event) => {
            if (!controlled) {
              listener(filename, event);
              const pending = expected;
              if (pending) {
                void Promise.all([
                  hasWorkspaceGitCheckout(workspace),
                  hasWorkspaceGitCheckout(path.join(plain, "nested")),
                ]).then((values) => {
                  if (values.every((value) => value === pending.value)) {
                    pending.resolve();
                  }
                }, pending.reject);
              }
            }
          },
          options,
        );
      },
    );
    expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
    expect(await hasWorkspaceGitCheckout(path.join(plain, "nested"))).toBe(false);
    if (delivery === "native") {
      expected = { ...Promise.withResolvers<void>(), value: false };
      void expected.promise.catch(() => undefined);
    }
    await fs.promises.unlink(alias);
    await fs.promises.symlink(plain, alias, "junction");
    if (expected) {
      await withinTest(expected.promise, signal);
    }
    await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(false));
    await fs.promises.mkdir(path.join(root, ".git"));
    expect(await findGitCheckoutRoot(workspace)).toBeNull();
    controlled = delivery === "named-change";
    expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);
    if (delivery === "native") {
      expected = { ...Promise.withResolvers<void>(), value: true };
      void expected.promise.catch(() => undefined);
    }
    await fs.promises.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    // A platform may report this membership transition as a named content change.
    if (controlled) {
      for (const listener of metadataListeners) {
        listener("HEAD", "change");
      }
    }
    if (expected) {
      await withinTest(expected.promise, signal);
    }
    await vi.waitFor(async () => {
      expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
      expect(await hasWorkspaceGitCheckout(path.join(plain, "nested"))).toBe(true);
    });
  },
);
