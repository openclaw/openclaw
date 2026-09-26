import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as durability from "./directory-durability.js";
import {
  encodePackageActivationLauncher,
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  preparePackageActivation,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import * as integrity from "./package-update-integrity.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as capability from "./update-post-core-capability.js";

const fixture = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixture.setup());
  const state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
});
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform === "win32").each([
  ["file", "EIO"],
  ["file", "EPERM"],
  ["directory", "EIO"],
] as const)(
  "does not acknowledge an unpersisted launcher %s %s and requires durability on recovery",
  (cut, code) =>
    fixture.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixture.writePostCoreCapability(f.params.stage.packageRoot);
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const failure = Object.assign(new Error("launcher durability interrupted"), { code });
      const handles: Array<{ fd: number; dev: bigint; ino: bigint }> = [];
      let refused = 0;
      const open = fsp.open;
      const openSpy = vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (cut === "file" && String(args[0]).includes(".openclaw-shim-stage-")) {
          const identity = await handle.stat({ bigint: true });
          if (identity.isFile()) {
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              handles.push({ fd: handle.fd, dev: identity.dev, ino: identity.ino });
              refused++;
              throw failure;
            });
          }
        }
        return handle;
      });
      const fsync = fs.fsyncSync;
      const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        const identity = fs.fstatSync(fd, { bigint: true });
        // Native fs-safe staging uses raw descriptors, not fs.promises.open.
        // Bind the fault to an actual file inode in this fixture's private staging.
        const staged =
          cut === "file" &&
          identity.isFile() &&
          fs
            .readdirSync(path.dirname(f.launcher))
            .filter((name) => name.startsWith(".openclaw-shim-stage-"))
            .some((name) => {
              const directory = path.join(path.dirname(f.launcher), name);
              return fs.readdirSync(directory).some((entry) => {
                const current = fs.lstatSync(path.join(directory, entry), { bigint: true });
                return (
                  current.isFile() && current.dev === identity.dev && current.ino === identity.ino
                );
              });
            });
        if (staged) {
          handles.push({ fd, dev: identity.dev, ino: identity.ino });
          refused++;
          throw failure;
        }
        fsync(fd);
      });
      const sync = durability.syncDirectory;
      const syncSpy = vi
        .spyOn(durability, "syncDirectory")
        .mockImplementation(async (directory) => {
          if (
            cut === "directory" &&
            directory === path.dirname(f.launcher) &&
            fs.readFileSync(f.launcher, "utf8") === "candidate launcher\n"
          ) {
            refused++;
            throw failure;
          }
          return sync(directory);
        });
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        const reader = integrity.createPackageIntegrityReader();
        const prepared = await preparePackageActivation({
          options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          installTarget: f.params.installTarget,
          liveRoot: f.packageRoot,
          stageRoot: f.params.stage.packageRoot,
          launcherRoot: f.params.stage.layout.binDir,
          binDir: path.dirname(f.launcher),
          previous: await reader.tree(f.packageRoot),
          launchers: [
            {
              name: "openclaw",
              previous: encodePackageActivationLauncher(await reader.launcher(f.launcher)),
            },
          ],
        });
        expect(prepared).toBeDefined();
        // Exercise the actual publication owner without the outer swap's automatic
        // compensation, leaving the interrupted operation available for recovery.
        await expect(prepared!.publish(false)).rejects.toThrow("launcher durability interrupted");
      });
      expect(refused).toBeGreaterThan(0);
      for (const handle of handles) {
        let current: fs.BigIntStats | undefined;
        try {
          current = fs.fstatSync(handle.fd, { bigint: true });
        } catch {
          /* Closed. */
        }
        expect(current?.dev === handle.dev && current?.ino === handle.ino).toBe(false);
      }
      const journal = openPackageActivationJournal(anchor);
      const pending = journal.read();
      expect(pending.phase).toBe("publishing");
      expect(pending.publications).toEqual([]);
      expect(fs.existsSync(path.join(anchor, "previous"))).toBe(true);
      if (cut === "directory") {
        expect(pending.intent).toMatchObject({ kind: "launcher", name: "openclaw" });
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        const before = refused;
        await expect(
          runPackageActivationRecovery(anchor, "repair", pending.descriptor.operationId),
        ).rejects.toBe(failure);
        expect(refused).toBeGreaterThan(before);
        expect(journal.read()).toEqual(pending);
      } else {
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
        expect(handles.length).toBeGreaterThan(0);
      }
      // The same recorded operation can finish only once the persistence boundary works.
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
      syncSpy.mockRestore();
      await expect(
        runPackageActivationRecovery(anchor, "repair", pending.descriptor.operationId),
      ).resolves.toMatchObject({ phase: "publication-complete" });
      await expect(
        runPackageActivationRecovery(anchor, "retire", pending.descriptor.operationId),
      ).resolves.toMatchObject({ phase: "complete" });
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
      expect(fs.existsSync(anchor)).toBe(false);
    }),
);

it.skipIf(process.platform === "win32")(
  "keeps the original preparation assertion after capability and integrity awaits",
  () =>
    fixture.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      const previous = await integrity.createPackageIntegrityReader().tree(f.packageRoot);
      const previousLauncher = await integrity.createPackageIntegrityReader().launcher(f.launcher);
      let release!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inspecting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let preparing: ReturnType<typeof preparePackageActivation> | undefined;
      let original: (() => void) | undefined;
      const onPrepared = vi.fn();
      let outcome: { value: unknown } | { error: unknown } | undefined;
      try {
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(f.packageRoot);
          original = fence.assertCurrent.bind(fence);
          vi.spyOn(capability, "supportsPostCoreExecutor").mockImplementation(async () => {
            await Promise.resolve();
            fence.assertCurrent = vi.fn();
            return true;
          });
          const create = integrity.createPackageIntegrityReader;
          vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((...args) => {
            const reader = create(...args);
            return {
              ...reader,
              tree: async (...treeArgs) => {
                const result = await reader.tree(...treeArgs);
                if (treeArgs[0] === f.params.stage.packageRoot) {
                  reached();
                  await paused;
                }
                return result;
              },
            };
          });
          preparing = preparePackageActivation({
            options: { fence, nodeRunner: process.execPath, onPrepared },
            installTarget: f.params.installTarget,
            liveRoot: f.packageRoot,
            stageRoot: f.params.stage.packageRoot,
            launcherRoot: f.params.stage.layout.binDir,
            binDir: path.dirname(f.launcher),
            previous,
            launchers: [
              { name: "openclaw", previous: encodePackageActivationLauncher(previousLauncher) },
            ],
          });
          void preparing.then(
            (value) => {
              outcome = { value };
            },
            (error: unknown) => {
              outcome = { error };
            },
          );
          const preparationSettled = preparing.then(
            () => {
              throw new Error("Preparation completed before the integrity pause.");
            },
            (error: unknown) => {
              throw new Error("Preparation failed before the integrity pause.", { cause: error });
            },
          );
          await Promise.race([inspecting, preparationSettled]);
          // Deliberately end the genuine executor scope while the admitted preparation
          // is paused. The test still owns and joins that escaped operation below.
        });
        expect(original).toBeTypeOf("function");
        expect(() => original!()).toThrow();
      } finally {
        release();
        if (preparing) {
          await Promise.allSettled([preparing]);
        }
      }
      expect(outcome).toMatchObject({ error: expect.any(Error) });
      expect(onPrepared).not.toHaveBeenCalled();
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      expect(fs.existsSync(anchor)).toBe(false);
      expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
      expect(fs.existsSync(f.params.stage.packageRoot)).toBe(true);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
    }),
);
