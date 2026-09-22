import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runner from "../../process/exec-runner.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

describe.skipIf(process.platform !== "darwin")("isolated native worktree operations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  beforeEach(() => {
    for (const name of [
      "FS_SAFE_NATIVE_MODE",
      "OPENCLAW_FS_SAFE_NATIVE_MODE",
      "FS_SAFE_PYTHON_MODE",
      "OPENCLAW_FS_SAFE_PYTHON_MODE",
    ]) {
      vi.stubEnv(name, undefined);
    }
    configureFsSafeNative({ mode: "off" });
  });
  afterEach(async () => {
    await drainGlobalSingletonLifecycleState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("clones and reads provenance with the host's native helper still off", async () => {
    const root = tempDirs.make("openclaw-native-policy-");
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend);
    expect(backend?.id).toBe("apfs");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await backend.createTemplate(source, options);
    await fs.writeFile(path.join(source, "payload"), Buffer.alloc(1024 * 1024, 0x5a));
    await backend.cloneTemplate(source, destination, options);
    const [original, cloned] = await nativeWorktreeFilesystem.readMetadata(
      [path.join(source, "payload"), path.join(destination, "payload")],
      options,
    );
    expect(original?.cloneId).toBe(getApfsCloneId(path.join(source, "payload")));
    expect(cloned?.cloneId).toBe(original?.cloneId);
    expect(cloned?.ino).not.toBe(original?.ino);
    expect(await fs.readFile(path.join(destination, "payload"))).toEqual(
      await fs.readFile(path.join(source, "payload")),
    );
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it.each(["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"])(
    "honors explicit %s=off in read and write children",
    async (name) => {
      vi.stubEnv(name, "off");
      const root = tempDirs.make("openclaw-native-disabled-");
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "payload"), "source");
      expect(await detectWorktreeFilesystemBackend(root, options)).toBeNull();
      await expect(
        nativeWorktreeFilesystem.copy(source, destination, options),
      ).rejects.toMatchObject({
        code: "helper-unavailable",
      });
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(getFsSafeNativeConfig().mode).toBe("off");
    },
  );

  it.each(["copy", "createSource"])(
    "revalidates allocation authority before child %s input",
    async (operation) => {
      const root = tempDirs.make("openclaw-native-admission-");
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
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

  it("joins an admitted write child after cancellation before returning to cleanup", async () => {
    const root = tempDirs.make("openclaw-native-settlement-");
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
      const root = process.argv[1];
      process.on('SIGTERM', () => fs.writeFileSync(path.join(root, 'canceled'), 'yes'));
      JSON.parse(fs.readFileSync(0, 'utf8'));
      fs.writeFileSync(path.join(root, 'ready'), 'yes');
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
      .copy(path.join(root, "source"), path.join(root, "destination"), {
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
    try {
      await expect.poll(() => fs.readFile(ready, "utf8").catch(() => "")).toBe("yes");
      controller.abort(new Error("allocation canceled"));
      await expect.poll(() => fs.readFile(canceled, "utf8").catch(() => "")).toBe("yes");
      expect(settled).toBe(false);
      await expect(fs.access(finished)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.writeFile(release, "yes");
      await pending;
    }
    expect(await pending).toMatchObject({ message: "allocation canceled" });
    expect(await fs.readFile(finished, "utf8")).toBe("yes");
  });
});
