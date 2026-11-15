import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { requirePinnedBun } from "../../../scripts/lib/pinned-bun.mjs";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runner from "../../process/exec-runner.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  captureWorkspaceFilesystemEvidence,
  createWorkspaceFilesystemSource,
} from "../workspace-state-guard.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";
import { cloneRefsTreeInWorker } from "./provisioned-copy-host.js";

const run = runner.runCommandBuffersWithTimeout;

const removalDirs = useAutoCleanupTempDirTracker(afterEach);
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "removes owned captures with read-only directories without changing linked live workspaces",
  async () => {
    const root = removalDirs.make("openclaw-native-removal-");
    const capture = path.join(root, "capture");
    const readonly = path.join(capture, "readonly");
    const ignored = path.join(capture, ".openclaw", "tmp", "ignored");
    const live = path.join(root, "live-workspace");
    for (const directory of [readonly, ignored, live]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "payload"), "retained", { mode: 0o400 });
    }
    await fs.symlink(live, path.join(ignored, "live-link"), "dir");
    await fs.chmod(readonly, 0o555);
    await fs.chmod(ignored, 0);
    await fs.chmod(live, 0o555);
    try {
      await nativeWorktreeFilesystem.remove(capture, { commitGuard: () => {} });
      await expect(fs.lstat(capture)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(live)).mode & 0o777).toBe(0o555);
      expect((await fs.stat(path.join(live, "payload"))).mode & 0o777).toBe(0o400);
      expect(await fs.readFile(path.join(live, "payload"), "utf8")).toBe("retained");
    } finally {
      // Restore only fixture-owned permissions if the removal regression fails.
      for (const directory of [readonly, ignored, live]) {
        await fs.chmod(directory, 0o700).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        });
      }
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves native mode across ReFS copies on a reused worker",
  () => {
    const root = removalDirs.make("refs-native-policy-");
    const modules = {
      copy: new URL("./provisioned-copy-host.ts", import.meta.url).href,
      diagnostics: new URL("../../infra/worker-request-diagnostics.ts", import.meta.url).href,
      lifecycle: new URL("../../shared/global-singleton.ts", import.meta.url).href,
    };
    const result = spawnSync(
      requirePinnedBun(),
      [
        "--no-addons",
        "--no-install",
        "--eval",
        `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { configureFsSafeNative } from "@openclaw/fs-safe/config";
    const { cloneRefsTreeInWorker } = await import(${JSON.stringify(modules.copy)});
    const { runWithWorkerStartObserver } = await import(${JSON.stringify(modules.diagnostics)});
    const { drainGlobalSingletonLifecycleState } = await import(${JSON.stringify(modules.lifecycle)});
    const root = ${JSON.stringify(root)};
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const started = [], outcomes = [];
    try {
      await runWithWorkerStartObserver(script => started.push(script), async () => {
        for (const [index, mode] of ["require", "off", "require"].entries()) {
          configureFsSafeNative({ mode });
          try {
            await cloneRefsTreeInWorker(source, path.join(root, "copy-" + index), { commitGuard() {} });
            outcomes.push("success");
          } catch (error) {
            outcomes.push(error.code);
          }
        }
      });
      console.log(JSON.stringify({ started, outcomes }));
    } finally {
      await drainGlobalSingletonLifecycleState();
    }
  `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      started: ["fs-safe-copy.worker.js"],
      outcomes: ["helper-unavailable", "success", "helper-unavailable"],
    });
  },
);

describe.skipIf(process.platform !== "darwin")("isolated native worktree operations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options: WorktreeFilesystemOptions = { commitGuard: () => {} };
  let root: string, source: string, destination: string;
  let cleanupWrite: (() => Promise<void>) | undefined;
  const copy = (request = options) => nativeWorktreeFilesystem.copy(source, destination, request);
  beforeEach(() => {
    root = tempDirs.make("openclaw-native-");
    source = path.join(root, "source");
    destination = path.join(root, "destination");
    for (const family of ["NATIVE", "PYTHON"]) {
      vi.stubEnv(`FS_SAFE_${family}_MODE`, undefined);
      vi.stubEnv(`OPENCLAW_FS_SAFE_${family}_MODE`, undefined);
    }
    configureFsSafeNative({ mode: "off" });
  });
  afterEach(async () => {
    try {
      // A timed-out body can still be unwinding; join before the earlier temp-dir hook runs.
      await cleanupWrite?.();
      await drainGlobalSingletonLifecycleState();
    } finally {
      cleanupWrite = undefined;
      configureFsSafeNative({ mode: undefined });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it("clones and reads provenance with the host's native helper still off", async () => {
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend?.id === "apfs", "APFS backend required");
    await backend.createTemplate(source, options);
    await fs.writeFile(path.join(source, "payload"), Buffer.alloc(1024 * 1024, 0x5a));
    await backend.cloneTemplate(source, destination, options);
    const [original, cloned] = await nativeWorktreeFilesystem.readMetadata(
      [path.join(source, "payload"), path.join(destination, "payload")],
      options,
    );
    assert(original && cloned && original.cloneId > 0n, "native clone provenance required");
    expect(cloned.cloneId).toBe(original.cloneId);
    expect(cloned.ino).not.toBe(original.ino);
    expect(await fs.readFile(path.join(destination, "payload"))).toEqual(
      await fs.readFile(path.join(source, "payload")),
    );
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it.each(["native", "refs-worker"] as const)(
    "refuses retargeted workspace authority at the %s copy owner",
    async (owner) => {
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "payload"), "original");
      const other = path.join(root, "other");
      const alias = path.join(root, "alias");
      await fs.mkdir(other);
      await fs.symlink(source, alias, "dir");
      const commitGuard = createWorkspaceFilesystemSource(
        await captureWorkspaceFilesystemEvidence(alias),
        () => {},
      );
      const authority = {
        commitGuard,
        workerAuthority: {
          assertCurrent: () => {},
          workspaceEvidence: [await captureWorkspaceFilesystemEvidence(other)],
        },
      };
      if (owner === "refs-worker") {
        configureFsSafeNative({ mode: "auto" });
        await cloneRefsTreeInWorker(source, destination, authority);
        expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("original");
        await fs.unlink(alias);
        await fs.symlink(other, alias, "dir");
        await expect(
          cloneRefsTreeInWorker(source, `${destination}-refused`, authority),
        ).rejects.toThrow(/alias points to a different/);
        await expect(fs.access(`${destination}-refused`)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        vi.spyOn(runner, "runCommandBuffersWithTimeout").mockImplementation(
          (argv, inputOptions) => {
            assert(typeof inputOptions !== "number");
            return run(argv, {
              ...inputOptions,
              prepareInput: async (pid, args) => {
                await fs.unlink(alias);
                await fs.symlink(other, alias, "dir");
                await inputOptions.prepareInput?.(pid, args);
              },
            });
          },
        );
        await expect(copy(authority)).rejects.toThrow(/alias points to a different/);
        await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
    },
  );

  it("retains prepared authority until the native copy settles", async () => {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "payload"), "original");
    let released = false;
    let prepared = false;
    const commitGuard = Object.assign(
      () => {
        if (prepared) {
          throw new Error("Raw callback used outside its prepared source scope");
        }
      },
      {
        prepareSessionSourceEffect: async () => {
          prepared = true;
          return {
            assertCurrent: () => {
              if (released) {
                throw new Error("effect authority released");
              }
            },
            release: async () => {
              await Promise.resolve();
              expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("original");
              released = true;
              prepared = false;
            },
          };
        },
      },
    );
    await copy({ commitGuard });
    expect(released).toBe(true);
  });

  it.each([
    "FS_SAFE_NATIVE_MODE",
    "OPENCLAW_FS_SAFE_NATIVE_MODE",
    "FS_SAFE_PYTHON_MODE",
    "OPENCLAW_FS_SAFE_PYTHON_MODE",
  ])("honors explicit %s=off in read and write children", async (name) => {
    vi.stubEnv(name, "off");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "payload"), "source");
    expect(await detectWorktreeFilesystemBackend(root, options)).toBeNull();
    await expect(copy()).rejects.toMatchObject({ code: "helper-unavailable" });
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["copy", "createSource", "remove"])(
    "revalidates %s authority before input",
    async (operation) => {
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "payload"), "source");
      const authority = new AbortController();
      let childPid: number | undefined;
      vi.spyOn(runner, "runCommandBuffersWithTimeout").mockImplementation(
        (argv, commandOptions) => {
          assert(typeof commandOptions !== "number", "Native writes need guarded input");
          return run(argv, {
            ...commandOptions,
            beforeInput(pid) {
              childPid = pid;
              authority.abort(new Error("allocation lease lost"));
              commandOptions.beforeInput?.(pid);
            },
          });
        },
      );
      const writeOptions = { commitGuard: () => authority.signal.throwIfAborted() };
      await expect(
        operation === "copy"
          ? copy(writeOptions)
          : operation === "remove"
            ? nativeWorktreeFilesystem.remove(source, writeOptions)
            : nativeWorktreeFilesystem.createSource(destination, writeOptions),
      ).rejects.toThrow("allocation lease lost");
      expect(childPid).toBeGreaterThan(0);
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("source");
    },
  );

  it("joins a canceled write child before cleanup", async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    const ready = path.join(root, "ready");
    const canceled = path.join(root, "canceled");
    const release = path.join(root, "release");
    const finished = path.join(root, "finished");
    // A controlled write child makes settlement observable independently of disk speed.
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { setTimeout } from 'node:timers/promises';
      import { serialize } from 'node:v8';
      ${fixtureReceiptClientSource(receipts.endpoint)}
      const root = process.argv[1];
      function record(name) {
        const marker = path.join(root, name);
        fs.writeFileSync(marker, 'yes');
        sendReceipt(marker, 'yes');
      }
      process.on('SIGTERM', () => record('canceled'));
      JSON.parse(fs.readFileSync(0, 'utf8'));
      record('ready');
      while (!fs.existsSync(path.join(root, 'release'))) await setTimeout(10);
      fs.writeFileSync(path.join(root, 'finished'), 'yes');
      process.stdout.write(serialize({ type: 'written' }));
    `;
    vi.spyOn(runner, "runCommandBuffersWithTimeout").mockImplementation((_argv, commandOptions) =>
      run([process.execPath, "--input-type=module", "--eval", script, root], commandOptions),
    );
    const controller = new AbortController();
    const settled = vi.fn();
    const pending = copy({ ...options, signal: controller.signal })
      .catch((error: unknown) => error)
      .finally(settled);
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        try {
          await fs.writeFile(release, "yes");
          await pending;
        } finally {
          await receipts.close();
        }
      })());
    cleanupWrite = cleanup;
    const waitForMarker = (marker: string) =>
      withinTest(
        Promise.race([
          receipts.waitFor(marker, "yes"),
          // The durable write precedes replies and exit; its receipt can arrive later.
          pending.then(() => expect(readFileSync(marker, "utf8")).toBe("yes")),
        ]),
        signal,
      );
    try {
      await waitForMarker(ready);
      controller.abort(new Error("allocation canceled"));
      await waitForMarker(canceled);
      expect(settled).not.toHaveBeenCalled();
      await expect(fs.access(finished)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
    expect(await pending).toMatchObject({ message: "allocation canceled" });
    expect(await fs.readFile(finished, "utf8")).toBe("yes");
  });
});
