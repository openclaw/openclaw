import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  readSystemdDefinitionMutationCapability,
  withSystemdDefinitionMutation,
} from "./systemd-definition-mutation.js";
import {
  setupSystemdDefinitionMutationFixture,
  writeFixtureFile,
  root,
  stateDir,
  unitPath,
  environmentPath,
  env,
  stage,
  managerDefinition,
  afterUnitTemporaryWrite,
  expectNoTemporaryFiles,
} from "./systemd-definition-mutation.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./systemd-definition-mutation.test-support.js"));

describe.skipIf(process.platform === "win32")("systemd definition mutation ownership", () => {
  setupSystemdDefinitionMutationFixture();

  it.each(["unit replacement"])(
    "preserves a concurrent %s change during first-load discovery",
    async (artifact) => {
      const shared = path.join(root, "service.d", "default.conf");
      await fs.mkdir(path.dirname(shared), { mode: 0o755 });
      await writeFixtureFile(shared, "[Service]\nTimeoutStopSec=30s\n");
      managerDefinition(unitPath, [shared], [], () =>
        fs.stat(unitPath).then(
          () => true,
          () => false,
        ),
      );
      const edited =
        artifact === "environment"
          ? environmentPath
          : artifact === "backup"
            ? `${unitPath}.bak`
            : unitPath;
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === unitPath) {
          expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
          if (artifact === "unit replacement") {
            const replacement = path.join(root, "operator-replacement");
            await writeFixtureFile(replacement, "OPERATOR=concurrent\n");
            await rename(replacement, edited);
          } else {
            await writeFixtureFile(edited, "OPERATOR=concurrent\n");
          }
        }
      });

      await expect(stage()).rejects.toThrow("changed during publication");

      expect(await fs.readFile(edited, "utf8")).toBe("OPERATOR=concurrent\n");
      for (const target of [unitPath, environmentPath]) {
        if (target !== edited) {
          await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(await fs.readFile(shared, "utf8")).toContain("30s");
      for (const directory of [path.dirname(unitPath), stateDir]) {
        await expectNoTemporaryFiles(directory);
      }
    },
  );

  it.each(["existing unit"])(
    "rejects new manager inputs after publication for a %s",
    async (scenario) => {
      const existing = scenario === "existing unit";
      const extra = path.join(
        root,
        scenario === "unit-specific drop-in" ? "owned.service.d" : "service.d",
        "operator.conf",
      );
      await fs.mkdir(path.dirname(extra), { mode: 0o755 });
      await writeFixtureFile(extra, "[Service]\nTimeoutStopSec=30s\n");
      if (existing) {
        await writeFixtureFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      let published = false;
      managerDefinition(unitPath, [], [], async () => existing);
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === unitPath && !published) {
          published = true;
          managerDefinition(
            scenario === "selected fragment" ? extra : unitPath,
            scenario === "selected fragment" ? [] : [extra],
            [],
            () =>
              fs.stat(unitPath).then(
                () => true,
                () => false,
              ),
          );
        }
      });

      await expect(stage()).rejects.toThrow("changed during publication");
      expect(await fs.readFile(extra, "utf8")).toContain("30s");
      if (existing) {
        expect(await fs.readFile(unitPath, "utf8")).toBe(
          "[Service]\nExecStart=/usr/bin/node gateway\n",
        );
      } else {
        await expect(fs.stat(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.stat(environmentPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["uid"] as const)("rejects changed %s between lstat and open", async (field) => {
    await writeFixtureFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === unitPath) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
          const opened = await stat(...statArgs);
          Object.defineProperty(opened, field, {
            value: typeof opened[field] === "bigint" ? opened[field] + 1n : opened[field] + 1,
          });
          return opened;
        });
      }
      return handle;
    });
    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({
      kind: "unknown",
    });
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each(["drop-in"])(
    "fingerprints a safe same-owner manager %s without snapshotting or restoring it",
    async (kind) => {
      const extra = path.join(root, "operator.conf");
      await writeFixtureFile(extra, "[Service]\nEnvironment=OWNER=first\n");
      await writeFixtureFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      await writeFixtureFile(environmentPath, "OPERATOR=preserved\n");
      managerDefinition(kind === "fragment" ? extra : unitPath, kind === "fragment" ? [] : [extra]);
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      await withSystemdDefinitionMutation(env, env, async (mutation) => {
        expect([...mutation.snapshots.keys()]).toEqual([unitPath, environmentPath]);
        await expect(mutation.publish(extra, "must not publish", 0o600)).rejects.toThrow(
          "Not a managed service publication target",
        );
        await expect(
          mutation.restore(extra, { contents: Buffer.from("must not restore"), mode: 0o600 }),
        ).rejects.toThrow("Not a managed service publication target");
        await mutation.publish(unitPath, "managed definition", 0o644);
        await mutation.restore(extra, null);
        expect(await fs.readFile(extra, "utf8")).toContain("OWNER=first");
        afterUnitTemporaryWrite(async () => {
          await writeFixtureFile(extra, "[Service]\nEnvironment=OWNER=second\n");
        });
        await expect(mutation.publish(unitPath, "must not publish", 0o644)).rejects.toThrow(
          "changed during publication",
        );
      });
      expect(await fs.readFile(unitPath, "utf8")).toBe("managed definition");
      expect(await fs.readFile(extra, "utf8")).toContain("OWNER=second");
      expect(await fs.readFile(environmentPath, "utf8")).toBe("OPERATOR=preserved\n");
      await expectNoTemporaryFiles(path.dirname(unitPath));
    },
  );

  it.each([{ artifact: "unit", select: () => unitPath, change: "between publications" }])(
    "rejects a concurrent $artifact edit $change",
    async ({ select, change }) => {
      const target = select();
      await withSystemdDefinitionMutation(env, env, async (mutation) => {
        if (change === "between publications") {
          await mutation.publish(target, "first publication", 0o600);
          await writeFixtureFile(target, "operator edit");
        } else {
          const rename = fs.rename.bind(fs);
          vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
            await rename(source, destination);
            if (destination === target) {
              if (change === "replacement after rename") {
                const replacement = path.join(root, "operator-replacement");
                await writeFixtureFile(replacement, "operator edit", { mode: 0o600 });
                await rename(replacement, target);
              } else {
                await writeFixtureFile(target, "operator edit");
              }
            }
          });
        }
        await expect(mutation.publish(target, "must not accept", 0o600)).rejects.toThrow(
          "changed during publication",
        );
      });
      expect(await fs.readFile(target, "utf8")).toBe("operator edit");
      await expectNoTemporaryFiles(path.dirname(target));
    },
  );

  it.each([
    { artifact: "unit", select: () => unitPath, existed: false },
    { artifact: "environment", select: () => environmentPath, existed: true },
  ])(
    "rolls back $artifact after a post-rename failure (existed=$existed)",
    async ({ select, existed }) => {
      const target = select();
      const extra = path.join(root, "operator.conf");
      await writeFixtureFile(extra, "[Service]\nEnvironment=OWNER=first\n");
      managerDefinition(extra);
      if (existed) {
        await writeFixtureFile(target, "previous definition", { mode: 0o400 });
      }
      const rename = fs.rename.bind(fs);
      let changed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === target && !changed) {
          changed = true;
          await writeFixtureFile(extra, "[Service]\nEnvironment=OWNER=second\n");
        }
      });
      await expect(
        withSystemdDefinitionMutation(env, env, (mutation) =>
          mutation.publish(target, "must not remain", 0o600),
        ),
      ).rejects.toThrow("changed during publication");
      if (existed) {
        expect(await fs.readFile(target, "utf8")).toBe("previous definition");
        expect((await fs.stat(target)).mode & 0o777).toBe(0o400);
      } else {
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readFile(extra, "utf8")).toContain("OWNER=second");
      await expectNoTemporaryFiles(path.dirname(target));
    },
  );

  it.each([{ artifact: "environment", select: () => environmentPath, environmentExisted: true }])(
    "stage rollback preserves a concurrent $artifact edit (env existed=$environmentExisted)",
    async ({ artifact, select, environmentExisted }) => {
      const previousUnit = "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\n";
      const previousEnvironment = "OPERATOR=original\n";
      await writeFixtureFile(unitPath, previousUnit);
      if (environmentExisted) {
        await writeFixtureFile(environmentPath, previousEnvironment);
      }
      const edited = select();
      const rename = fs.rename.bind(fs);
      let changed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (destination === unitPath && !changed) {
          changed = true;
          expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
          await writeFixtureFile(edited, "OPERATOR=concurrent\n");
        }
      });

      await expect(stage()).rejects.toThrow("changed during publication");

      expect(await fs.readFile(edited, "utf8")).toBe("OPERATOR=concurrent\n");
      if (artifact !== "unit") {
        expect(await fs.readFile(unitPath, "utf8")).toBe(previousUnit);
      }
      if (artifact !== "environment") {
        if (environmentExisted) {
          expect(await fs.readFile(environmentPath, "utf8")).toBe(previousEnvironment);
        } else {
          await expect(fs.stat(environmentPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      for (const directory of [path.dirname(unitPath), stateDir]) {
        await expectNoTemporaryFiles(directory);
      }
    },
  );

  it.each([
    { mount: "file-ro", mode: 0o400, kind: "sealed" },
    { mount: "file-rw", mode: 0o644, kind: "sealed" },
  ])("inspects a mounted target before staging ($mount, $mode)", async ({ mount, mode, kind }) => {
    await writeFixtureFile(unitPath, "original definition", { mode });
    const open = fs.open.bind(fs);
    const readFile = fs.readFile.bind(fs);
    let targetFd: number | undefined;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === unitPath) {
        targetFd = handle.fd;
      }
      return handle;
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
        return `mnt_id:\t${args[0] === `/proc/self/fdinfo/${targetFd}` && mount !== "ordinary" ? 2 : 1}\n`;
      }
      if (args[0] === "/proc/self/mountinfo") {
        if (mount === "unavailable") {
          throw Object.assign(new Error("proc unavailable"), { code: "EACCES" });
        }
        const escaped = unitPath.replaceAll(" ", "\\040");
        return `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:1 /unit ${escaped} ${mount === "file-ro" ? "ro" : "rw"} - tmpfs tmpfs rw\n`;
      }
      return readFile(...args);
    });

    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({ kind });
    if (kind === "writable") {
      await stage();
      expect(await fs.readFile(unitPath, "utf8")).toContain("/srv/openclaw/dist/index.js");
      expect((await fs.stat(unitPath)).mode & 0o777).toBe(mode);
    } else {
      await expect(stage()).rejects.toThrow(`SERVICE_DEFINITION_${kind.toUpperCase()}`);
      expect(await fs.readFile(unitPath, "utf8")).toBe("original definition");
      expect(await fs.readdir(stateDir)).toEqual([]);
      expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
    }
  });

  it("cleans unpublished temporary files after a write failure", async () => {
    await writeFixtureFile(unitPath, "previous definition");
    afterUnitTemporaryWrite(() => {
      throw new Error("write failed");
    });
    await expect(
      withSystemdDefinitionMutation(env, env, (mutation) =>
        mutation.publish(unitPath, "must not remain", 0o600),
      ),
    ).rejects.toThrow("write failed");
    expect(await fs.readFile(unitPath, "utf8")).toBe("previous definition");
    await expectNoTemporaryFiles(path.dirname(unitPath));
  });

  it("rejects manager definition path changes during publication", async () => {
    const first = path.join(root, "first.conf");
    const second = path.join(root, "second.conf");
    await writeFixtureFile(first, "[Service]\nEnvironment=OWNER=first\n");
    await writeFixtureFile(second, "[Service]\nEnvironment=OWNER=second\n");
    await writeFixtureFile(unitPath, "original definition");
    managerDefinition(unitPath, [first]);

    await expect(
      withSystemdDefinitionMutation(env, env, async (mutation) => {
        afterUnitTemporaryWrite(() => {
          managerDefinition(unitPath, [second]);
        });
        await mutation.publish(unitPath, "must not publish", 0o644);
      }),
    ).rejects.toThrow("changed during publication");
    expect(await fs.readFile(unitPath, "utf8")).toBe("original definition");
  });

  it.each(["environment", "unit", "directory alias", "retargeted unit", "retargeted environment"])(
    "serializes canonical targets across concurrent writers (%s)",
    async (shared) => {
      const retarget = shared.startsWith("retargeted");
      const file = shared.includes("environment") ? environmentPath : unitPath;
      const directory = path.dirname(file);
      const original = path.join(root, "original");
      const replacement = path.join(root, "replacement");
      const other = { ...env };
      if (retarget) {
        await fs.rename(directory, original);
        await fs.mkdir(replacement, { mode: 0o755 });
        await fs.symlink(original, directory);
      } else if (shared === "environment") {
        other.OPENCLAW_SYSTEMD_UNIT = "openclaw-secondary";
      } else {
        other.OPENCLAW_STATE_DIR = path.join(root, "other-state");
        await fs.mkdir(other.OPENCLAW_STATE_DIR, { mode: 0o700 });
        if (shared === "directory alias") {
          other.HOME = path.join(root, "home-alias");
          await fs.symlink(env.HOME!, other.HOME);
        }
      }
      const events: string[] = [];
      const { promise: barrier, resolve: release } = createDeferred();
      const { promise: firstStarted, resolve: entered } = createDeferred();
      const first = withSystemdDefinitionMutation(env, env, async (mutation) => {
        events.push("first-start");
        entered();
        await barrier;
        if (!retarget) {
          await mutation.publish(file, "first writer", 0o600);
        }
        events.push("first-finish");
      });
      await firstStarted;
      const open = fs.open.bind(fs);
      let contended = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        // Reading a held sidecar follows the real owner's failed exclusive acquire.
        if (typeof args[0] === "string" && args[0].endsWith(".lock")) {
          contended = true;
        }
        return handle;
      });
      const second = withSystemdDefinitionMutation(other, other, async (mutation) => {
        events.push("second-start");
        const target = shared === "directory alias" ? file.replace(env.HOME!, other.HOME!) : file;
        if (!retarget) {
          expect(mutation.snapshots.get(target)?.contents.toString()).toBe("first writer");
        }
        await mutation.publish(target, "second writer", 0o600);
      });
      try {
        await vi.waitFor(() => expect(contended).toBe(true));
        expect(events).toEqual(["first-start"]);
        if (retarget) {
          await fs.unlink(directory);
          await fs.symlink(replacement, directory);
        }
      } finally {
        release();
      }
      await first;
      if (retarget) {
        await expect(second).rejects.toThrow("lock targets changed");
        expect(events).toEqual(["first-start", "first-finish"]);
        expect(await fs.readdir(original)).toEqual([]);
        expect(await fs.readdir(replacement)).toEqual([]);
      } else {
        await second;
        expect(events).toEqual(["first-start", "first-finish", "second-start"]);
        expect(await fs.readFile(file, "utf8")).toBe("second writer");
      }
    },
  );

  it("bounds lock acquisition by the mutation deadline", async () => {
    const { promise: barrier, resolve: release } = createDeferred();
    const { promise: firstStarted, resolve: entered } = createDeferred();
    const first = withSystemdDefinitionMutation(env, env, async () => {
      entered();
      await barrier;
    });
    await firstStarted;

    const startedAt = Date.now();
    try {
      await expect(
        withSystemdDefinitionMutation(env, env, async () => undefined, { timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      release();
      await first;
    }
  });
});
