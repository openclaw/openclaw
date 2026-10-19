import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runner from "../../process/exec-runner.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

describe.skipIf(process.platform !== "darwin")("isolated native worktree operations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  let root: string, source: string, destination: string;
  let cleanupWrite: (() => Promise<void>) | undefined;
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
    assert(backend);
    expect(backend?.id).toBe("apfs");
    await backend.createTemplate(source, options);
    await fs.writeFile(path.join(source, "payload"), Buffer.alloc(1024 * 1024, 0x5a));
    await backend.cloneTemplate(source, destination, options);
    const [original, cloned] = await nativeWorktreeFilesystem.readMetadata(
      [path.join(source, "payload"), path.join(destination, "payload")],
      options,
    );
    assert(original);
    assert(cloned);
    expect(original.cloneId).toBeGreaterThan(0n);
    expect(cloned.cloneId).toBe(original.cloneId);
    expect(cloned.ino).not.toBe(original.ino);
    expect(await fs.readFile(path.join(destination, "payload"))).toEqual(
      await fs.readFile(path.join(source, "payload")),
    );
    expect(getFsSafeNativeConfig().mode).toBe("off");
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
    await expect(nativeWorktreeFilesystem.copy(source, destination, options)).rejects.toMatchObject(
      {
        code: "helper-unavailable",
      },
    );
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it.each(["copy", "createSource"])(
    "revalidates allocation authority before child %s input",
    async (operation) => {
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "payload"), "source");
      const run = runner.runCommandBuffersWithTimeout;
      let authorized = true;
      let childPid: number | undefined;
      vi.spyOn(runner, "runCommandBuffersWithTimeout").mockImplementation(
        (argv, commandOptions) => {
          if (typeof commandOptions === "number") {
            throw new Error("Native writes need guarded input");
          }
          return run(argv, {
            ...commandOptions,
            beforeInput(pid) {
              childPid = pid;
              authorized = false;
              commandOptions.beforeInput?.(pid);
            },
          });
        },
      );
      const writeOptions = {
        commitGuard() {
          if (!authorized) {
            throw new Error("allocation lease lost");
          }
        },
      };
      await expect(
        operation === "copy"
          ? nativeWorktreeFilesystem.copy(source, destination, writeOptions)
          : nativeWorktreeFilesystem.createSource(destination, writeOptions),
      ).rejects.toThrow("allocation lease lost");
      expect(childPid).toBeGreaterThan(0);
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("joins a canceled write child before cleanup", async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    const ready = path.join(root, "ready");
    const canceled = path.join(root, "canceled");
    const release = path.join(root, "release");
    const finished = path.join(root, "finished");
    const run = runner.runCommandBuffersWithTimeout;
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
    let settled = false;
    const pending = nativeWorktreeFilesystem
      .copy(source, destination, {
        ...options,
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
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
          pending.then(() => {
            // The durable write precedes replies and exit; its receipt can arrive later.
            expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("yes");
          }),
        ]),
        signal,
      );
    try {
      await waitForMarker(ready);
      controller.abort(new Error("allocation canceled"));
      await waitForMarker(canceled);
      expect(settled).toBe(false);
      await expect(fs.access(finished)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
    expect(await pending).toMatchObject({ message: "allocation canceled" });
    expect(await fs.readFile(finished, "utf8")).toBe("yes");
  });
});
