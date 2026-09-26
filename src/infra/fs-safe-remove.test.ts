import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRebindableDirectoryAlias } from "../test-utils/symlink-rebind-race.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { removePathWithinRoot } from "./fs-safe-remove.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

async function expectRejectCode(promise: Promise<unknown>, expected: string | RegExp) {
  const err = await promise.catch((caught: unknown) => caught);
  if (err === undefined) {
    throw new Error("Expected promise to reject");
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof expected === "string") {
    expect(code).toBe(expected);
  } else {
    expect(code).toMatch(expected);
  }
}

function loadWindowsFileApi() {
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  return {
    createFile: kernel32.func(
      "intptr_t __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t attributes, void *templateFile)",
    ),
    closeHandle: kernel32.func("int __stdcall CloseHandle(intptr_t handle)"),
    getFileAttributes: kernel32.func("uint32_t __stdcall GetFileAttributesW(const char16_t *path)"),
    setFileAttributes: kernel32.func(
      "int __stdcall SetFileAttributesW(const char16_t *path, uint32_t attributes)",
    ),
  };
}

describe("removePathWithinRoot", () => {
  it("removes a file within root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "nested", "shared.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "hello");

    await removePathWithinRoot({
      rootDir: root,
      relativePath: path.join("nested", "shared.txt"),
      force: false,
    });

    await expectRejectCode(fs.stat(targetPath), "ENOENT");
  });

  it.each(
    (["file", "tree"] as const).flatMap((kind) =>
      (["relative", "absolute", "alias", "home"] as const).map((input) => ({ kind, input })),
    ),
  )(
    "preserves $input path semantics while removing a $kind beside a literal tilde",
    async ({ kind, input }) => {
      const root = await fs.realpath(await tempDirs.make("openclaw-fs-safe-tilde-"));
      const literalRoot = path.join(root, "~");
      const name = kind === "tree" ? "tree" : "note.txt";
      const literalTarget = path.join(literalRoot, name);
      const homeTarget = path.join(root, name);
      const target = input === "home" ? homeTarget : literalTarget;
      const sentinel = input === "home" ? literalTarget : homeTarget;
      await fs.mkdir(literalRoot);
      for (const [entry, content] of [
        [target, "selected"],
        [sentinel, "retained"],
      ] as const) {
        const leaf = kind === "tree" ? path.join(entry, "nested", "leaf.txt") : entry;
        await fs.mkdir(path.dirname(leaf), { recursive: true });
        await fs.writeFile(leaf, content);
      }
      const alias = path.join(root, "selected");
      if (input === "alias") {
        await createRebindableDirectoryAlias({ aliasPath: alias, targetPath: literalRoot });
      }
      const sentinelLeaf = kind === "tree" ? path.join(sentinel, "nested", "leaf.txt") : sentinel;
      const sentinelIdentity = await fs.lstat(sentinel, { bigint: true });
      const sentinelLeafIdentity = await fs.lstat(sentinelLeaf, { bigint: true });
      const inputs = {
        relative: "./~/" + name,
        absolute: literalTarget,
        alias: path.join("selected", name),
        home: "~/" + name,
      };
      const previousHome = process.env.HOME;
      process.env.HOME = root;
      try {
        await removePathWithinRoot({
          rootDir: root,
          relativePath: inputs[input],
          recursive: kind === "tree",
          force: false,
        });

        await expectRejectCode(fs.lstat(target), "ENOENT");
        expect(await fs.lstat(sentinel, { bigint: true })).toMatchObject({
          dev: sentinelIdentity.dev,
          ino: sentinelIdentity.ino,
        });
        expect(await fs.lstat(sentinelLeaf, { bigint: true })).toMatchObject({
          dev: sentinelLeafIdentity.dev,
          ino: sentinelLeafIdentity.ino,
        });
        expect(await fs.readFile(sentinelLeaf, "utf8")).toBe("retained");
        if (input === "alias") {
          expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
        }
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    },
  );

  it("removes an empty directory within root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "nested", "empty");
    await fs.mkdir(targetPath, { recursive: true });

    await removePathWithinRoot({
      rootDir: root,
      relativePath: path.join("nested", "empty"),
      force: false,
    });

    await expectRejectCode(fs.stat(targetPath), "ENOENT");
  });

  it("rejects non-recursive removal of non-empty directories", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetDir = path.join(root, "nested");
    const childPath = path.join(targetDir, "child.txt");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(childPath, "hello");

    await expectRejectCode(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "nested",
        force: true,
      }),
      // fs-safe 0.5.2 reports the documented typed remove codes instead of raw errnos.
      "not-empty",
    );
    await expect(fs.readFile(childPath, "utf8")).resolves.toBe("hello");
  });

  it("removes directory trees recursively", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.mkdir(path.join(root, "tree", "b-dir"), { recursive: true });
    await fs.mkdir(path.join(root, "tree", "a-dir", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "tree", "b-dir", "b.txt"), "b");
    await fs.writeFile(path.join(root, "tree", "a-dir", "nested", "a.txt"), "a");
    const deepDirectory = path.join(root, "tree", ...Array.from({ length: 65 }, () => "d"));
    await fs.mkdir(deepDirectory, { recursive: true });
    await fs.writeFile(path.join(deepDirectory, "leaf.txt"), "deep");

    await removePathWithinRoot({
      rootDir: root,
      relativePath: "tree",
      recursive: true,
      force: false,
    });

    await expectRejectCode(fs.stat(path.join(root, "tree")), "ENOENT");
  });

  it.each([
    { kind: "file", force: undefined },
    { kind: "file", force: false },
    { kind: "file", force: true },
    { kind: "directory", force: undefined },
    { kind: "directory", force: false },
    { kind: "directory", force: true },
  ])("handles a captured $kind disappearing with force=$force", async ({ kind, force }) => {
    const root = await fs.realpath(await tempDirs.make("openclaw-fs-safe-missing-leaf-"));
    const tree = path.join(root, "tree");
    const first = path.join(tree, "a.txt");
    const vanished = path.join(tree, "b");
    const last = path.join(tree, "c.txt");
    await fs.mkdir(tree);
    await fs.writeFile(first, "first");
    if (kind === "directory") {
      await fs.mkdir(vanished);
    } else {
      await fs.writeFile(vanished, "second");
    }
    await fs.writeFile(last, "last");
    const unlink = fs.unlink.bind(fs);
    const rmdir = fs.rmdir.bind(fs);
    let injections = 0;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
      await unlink(...args);
      if (String(args[0]) === first) {
        injections += 1;
        // All children were captured before the first real unlink completed.
        if (kind === "directory") {
          await rmdir(vanished);
        } else {
          await unlink(vanished);
        }
      }
    });
    const rmdirSpy = vi.spyOn(fs, "rmdir");
    const removal = removePathWithinRoot({
      rootDir: root,
      relativePath: "tree",
      recursive: true,
      force,
    });

    if (force === false) {
      await expectRejectCode(removal, "not-found");
      expect(await fs.readFile(last, "utf8")).toBe("last");
      expect(rmdirSpy).not.toHaveBeenCalled();
    } else {
      await removal;
      await expectRejectCode(fs.lstat(tree), "ENOENT");
      expect(rmdirSpy.mock.calls.map(([target]) => String(target))).toEqual([tree]);
    }
    expect(injections).toBe(1);
    expect(unlinkSpy.mock.calls.map(([target]) => String(target))).toEqual(
      force === false ? [first] : [first, last],
    );
    await expectRejectCode(fs.lstat(first), "ENOENT");
    await expectRejectCode(fs.lstat(vanished), "ENOENT");
  });

  it("rejects an equal-byte replacement of a captured sibling instead of treating it as absent", async () => {
    const root = await fs.realpath(await tempDirs.make("openclaw-fs-safe-replaced-leaf-"));
    const tree = path.join(root, "tree");
    const first = path.join(tree, "a.txt");
    const replaced = path.join(tree, "b.txt");
    const retained = path.join(root, "retained.txt");
    await fs.mkdir(tree);
    await fs.writeFile(first, "first");
    await fs.writeFile(replaced, "same bytes");
    await fs.writeFile(path.join(tree, "c.txt"), "last");
    const original = await fs.lstat(replaced, { bigint: true });
    const unlink = fs.unlink.bind(fs);
    let injections = 0;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
      await unlink(...args);
      if (String(args[0]) === first) {
        injections += 1;
        await fs.rename(replaced, retained);
        await fs.writeFile(replaced, "same bytes");
      }
    });
    const rmdir = vi.spyOn(fs, "rmdir");

    await expectRejectCode(
      removePathWithinRoot({ rootDir: root, relativePath: "tree", recursive: true, force: true }),
      "path-mismatch",
    );

    expect(injections).toBe(1);
    expect(unlinkSpy).toHaveBeenCalledOnce();
    expect(rmdir).not.toHaveBeenCalled();
    expect(await fs.lstat(retained, { bigint: true })).toMatchObject({
      dev: original.dev,
      ino: original.ino,
    });
    expect((await fs.lstat(replaced, { bigint: true })).ino).not.toBe(original.ino);
    expect(await fs.readFile(replaced, "utf8")).toBe("same bytes");
    expect(await fs.readFile(path.join(tree, "c.txt"), "utf8")).toBe("last");
  });

  it.each([
    { name: "false", refusal: false },
    { name: "undefined", refusal: undefined },
    { name: "ENOENT", refusal: Object.assign(new Error("owner missing"), { code: "ENOENT" }) },
  ])(
    "preserves a $name authority refusal when a captured sibling also disappears",
    async ({ refusal }) => {
      const root = await fs.realpath(await tempDirs.make("openclaw-fs-safe-missing-owner-"));
      const tree = path.join(root, "tree");
      const first = path.join(tree, "a.txt");
      const vanished = path.join(tree, "b.txt");
      await fs.mkdir(tree);
      await fs.writeFile(first, "first");
      await fs.writeFile(vanished, "second");
      await fs.writeFile(path.join(tree, "c.txt"), "last");
      const unlink = fs.unlink.bind(fs);
      let injections = 0;
      let refusals = 0;
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
        await unlink(...args);
        if (String(args[0]) === first) {
          await unlink(vanished);
          injections += 1;
        }
      });
      const rmdir = vi.spyOn(fs, "rmdir");
      const outcome = await removePathWithinRoot({
        rootDir: root,
        relativePath: "tree",
        recursive: true,
        force: true,
        assertBeforeMutation() {
          if (injections === 1 && refusals === 0) {
            refusals += 1;
            // Intentional non-Error refusal to prove exact pass-through semantics.
            // oxlint-disable-next-line typescript/only-throw-error
            throw refusal;
          }
        },
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        throw new Error("missing sibling hid the original authority refusal");
      }
      expect(outcome.error).toBe(refusal);
      expect(injections).toBe(1);
      expect(refusals).toBe(1);
      expect(unlinkSpy).toHaveBeenCalledOnce();
      expect(rmdir).not.toHaveBeenCalled();
      await expectRejectCode(fs.lstat(first), "ENOENT");
      await expectRejectCode(fs.lstat(vanished), "ENOENT");
      expect(await fs.readFile(path.join(tree, "c.txt"), "utf8")).toBe("last");
    },
  );

  it.each([
    { name: "resolved Promise", returned: () => Promise.resolve() },
    // Deliberately thenable assertions must be refused before filesystem effects.
    // oxlint-disable-next-line unicorn/no-thenable
    { name: "object thenable", returned: () => ({ then: (resolve: () => void) => resolve() }) },
    {
      name: "function thenable",
      // Function thenables must be refused just like object thenables.
      // oxlint-disable-next-line unicorn/no-thenable
      returned: () => Object.assign(() => undefined, { then: (resolve: () => void) => resolve() }),
    },
  ])("rejects a $name assertion before any recursive filesystem effect", async ({ returned }) => {
    const root = await tempDirs.make("openclaw-fs-safe-async-owner-");
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "retained.txt"), "original");
    const assertBeforeMutation = vi.fn<() => unknown>(returned);
    const unlink = vi.spyOn(fs, "unlink");
    const rmdir = vi.spyOn(fs, "rmdir");

    await expect(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "tree",
        recursive: true,
        assertBeforeMutation,
      }),
    ).rejects.toThrow(TypeError);

    expect(assertBeforeMutation).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(tree, "retained.txt"), "utf8")).toBe("original");
  });

  it("consumes a delayed assertion rejection after refusing synchronously", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-delayed-owner-");
    const target = path.join(root, "retained.txt");
    await fs.writeFile(target, "original");
    const assertion = createDeferred();
    let assertionCalls = 0;
    // Keep this callback unmocked: spies consume returned Promise rejections.
    const assertBeforeMutation: () => unknown = () => {
      assertionCalls += 1;
      return assertion.promise;
    };
    const unlink = vi.spyOn(fs, "unlink");
    const rmdir = vi.spyOn(fs, "rmdir");
    try {
      await expect(
        removePathWithinRoot({ rootDir: root, relativePath: "retained.txt", assertBeforeMutation }),
      ).rejects.toThrow(TypeError);
      expect(assertionCalls).toBe(1);
      expect(unlink).not.toHaveBeenCalled();
      expect(rmdir).not.toHaveBeenCalled();
      expect(await fs.readFile(target, "utf8")).toBe("original");
    } finally {
      // No test-side catch: Vitest's unhandled-rejection capture must stay clean.
      assertion.reject(new Error("delayed owner refusal"));
      await setImmediate();
    }
  });

  it("ignores an ordinary synchronous false return from a mutation assertion", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-sync-owner-");
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "owned");
    const assertBeforeMutation = vi.fn(() => false);
    const unlink = vi.spyOn(fs, "unlink");

    await removePathWithinRoot({ rootDir: root, relativePath: "target.txt", assertBeforeMutation });

    expect(assertBeforeMutation).toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledOnce();
    await expectRejectCode(fs.lstat(target), "ENOENT");
  });

  it("stops sorted recursive removal at a symlink and preserves later entries", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    await fs.writeFile(path.join(tree, "z-last.txt"), "last");
    await createRebindableDirectoryAlias({
      aliasPath: path.join(tree, "m-link"),
      targetPath: outside,
    });
    await fs.writeFile(path.join(tree, "a-first.txt"), "first");

    await expect(
      removePathWithinRoot({ rootDir: root, relativePath: "tree", recursive: true, force: true }),
    ).rejects.toMatchObject({
      code: "symlink",
      message: `symlink not allowed: ${path.join("tree", "m-link")}`,
    });

    await expectRejectCode(fs.stat(path.join(tree, "a-first.txt")), "ENOENT");
    await expect(fs.readFile(path.join(tree, "z-last.txt"), "utf8")).resolves.toBe("last");
    await expect(fs.readFile(path.join(outside, "keep.txt"), "utf8")).resolves.toBe("outside");
    expect((await fs.lstat(path.join(tree, "m-link"))).isSymbolicLink()).toBe(true);
  });

  it("suppresses only not-found errors when force is enabled", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");

    await expect(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "missing.txt",
      }),
    ).resolves.toBeUndefined();
    await expectRejectCode(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "missing.txt",
        force: false,
      }),
      "not-found",
    );
  });

  it.each([undefined, false, true])("handles a missing parent with force=%s", async (force) => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const parentPath = path.join(root, "missing-parent");
    const removal = removePathWithinRoot({
      rootDir: root,
      relativePath: path.join("missing-parent", "target.txt"),
      recursive: true,
      force,
    });

    if (force === false) {
      await expectRejectCode(removal, "not-found");
    } else {
      await expect(removal).resolves.toBeUndefined();
    }
    await expectRejectCode(fs.stat(parentPath), "ENOENT");
  });

  it.each([undefined, false, true])("rejects a missing root with force=%s", async (force) => {
    const parent = await tempDirs.make("openclaw-fs-safe-root-");
    const root = path.join(parent, "missing-root");

    await expectRejectCode(
      removePathWithinRoot({ rootDir: root, relativePath: "target.txt", force }),
      "not-found",
    );
    await expectRejectCode(fs.stat(root), "ENOENT");
  });

  it("rejects symlink and junction targets", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "target.txt"), "hello");
    await createRebindableDirectoryAlias({
      aliasPath: aliasDir,
      targetPath: realDir,
    });

    await expectRejectCode(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "alias",
        recursive: true,
        force: true,
      }),
      "symlink",
    );
    await expect(fs.readFile(path.join(realDir, "target.txt"), "utf8")).resolves.toBe("hello");
  });

  it("unlinks package symlink and junction leaves without traversing their targets", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    await fs.mkdir(path.join(root, "tree"));
    await fs.writeFile(path.join(outside, "retained.txt"), "outside");
    await createRebindableDirectoryAlias({
      aliasPath: path.join(root, "tree", "link"),
      targetPath: outside,
    });

    await removePathWithinRoot({
      rootDir: root,
      relativePath: "tree",
      recursive: true,
      symlinks: "unlink",
    });

    await expectRejectCode(fs.lstat(path.join(root, "tree")), "ENOENT");
    expect(await fs.readFile(path.join(outside, "retained.txt"), "utf8")).toBe("outside");
  });

  it("keeps explicitly selected in-root parent aliases usable", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.mkdir(path.join(root, "real"));
    await fs.writeFile(path.join(root, "real", "target.txt"), "owned");
    await createRebindableDirectoryAlias({
      aliasPath: path.join(root, "alias"),
      targetPath: path.join(root, "real"),
    });

    await removePathWithinRoot({
      rootDir: root,
      relativePath: path.join("alias", "target.txt"),
      force: false,
    });

    await expectRejectCode(fs.lstat(path.join(root, "real", "target.txt")), "ENOENT");
    expect((await fs.lstat(path.join(root, "alias"))).isSymbolicLink()).toBe(true);
  });

  it.each([
    { name: "Error", refusal: new Error("owner closed") },
    { name: "undefined", refusal: undefined },
    { name: "null", refusal: null },
    { name: "false", refusal: false },
    { name: "zero", refusal: 0 },
    { name: "ENOENT", refusal: Object.assign(new Error("owner missing"), { code: "ENOENT" }) },
    { name: "EBUSY", refusal: Object.assign(new Error("owner replaced"), { code: "EBUSY" }) },
  ])("retains a one-shot $name refusal before a recursive leaf mutation", async ({ refusal }) => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "a.txt"), "first");
    await fs.writeFile(path.join(tree, "b.txt"), "second");
    let armed = false;
    let refusals = 0;
    const mutations: string[] = [];
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation(operation, target) {
        if (operation === "remove") {
          mutations.push(path.basename(target));
          armed = path.basename(target) === "b.txt";
        }
      },
    });

    const outcome = await removePathWithinRoot({
      rootDir: root,
      relativePath: "tree",
      recursive: true,
      force: true,
      assertBeforeMutation: () => {
        if (armed && refusals === 0) {
          refusals += 1;
          // Intentional non-Error refusal to prove exact pass-through semantics.
          // oxlint-disable-next-line typescript/only-throw-error
          throw refusal;
        }
      },
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("recursive removal accepted a refused owner");
    }
    expect(outcome.error).toBe(refusal);
    expect(refusals).toBe(1);
    expect(mutations).toEqual(["a.txt", "b.txt"]);
    await expectRejectCode(fs.lstat(path.join(tree, "a.txt")), "ENOENT");
    expect(await fs.readFile(path.join(tree, "b.txt"), "utf8")).toBe("second");
  });

  it("does not adopt a replaced parent between recursive leaf operations", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const tree = path.join(root, "tree");
    const retained = path.join(root, "retained");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "a.txt"), "first");
    await fs.writeFile(path.join(tree, "b.txt"), "original");
    const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
    const remove = prototype.remove;
    let replaced = false;
    vi.spyOn(prototype, "remove").mockImplementation(async function (this: Root, target, options) {
      await remove.call(this, target, options);
      if (!replaced && path.basename(target) === "a.txt") {
        replaced = true;
        await fs.rename(tree, retained);
        await fs.mkdir(tree);
        await fs.writeFile(path.join(tree, "b.txt"), "successor");
      }
    });

    await expectRejectCode(
      removePathWithinRoot({ rootDir: root, relativePath: "tree", recursive: true }),
      "path-mismatch",
    );

    expect(replaced).toBe(true);
    expect(await fs.readFile(path.join(tree, "b.txt"), "utf8")).toBe("successor");
    expect(await fs.readFile(path.join(retained, "b.txt"), "utf8")).toBe("original");
    await expectRejectCode(fs.lstat(path.join(retained, "a.txt")), "ENOENT");
  });

  it.each(["unchanged", "replaced"] as const)(
    "preserves a sharing failure without retrying while its captured target remains %s",
    async (targetState) => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const target = path.join(root, "target.txt");
      const retained = path.join(root, "retained.txt");
      await fs.writeFile(target, "original");
      const identity = await fs.lstat(target, { bigint: true });
      const sharingFailure = Object.assign(new Error("sharing failure"), { code: "EBUSY" });
      const prototype = Object.getPrototypeOf(await fsSafeRoot(root)) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
      const remove = prototype.remove;
      let attempts = 0;
      vi.spyOn(prototype, "remove").mockImplementation(async function (this: Root, entry, options) {
        attempts += 1;
        if (attempts === 1) {
          if (targetState === "replaced") {
            await fs.rename(target, retained);
            await fs.writeFile(target, "successor");
          }
          throw sharingFailure;
        }
        await remove.call(this, entry, options);
      });
      const removal = removePathWithinRoot({
        rootDir: root,
        relativePath: "target.txt",
      });

      if (targetState === "unchanged") {
        await expect(removal).rejects.toBe(sharingFailure);
        expect(attempts).toBe(1);
        expect(await fs.lstat(target, { bigint: true })).toMatchObject({
          dev: identity.dev,
          ino: identity.ino,
        });
        expect(await fs.readFile(target, "utf8")).toBe("original");
      } else {
        await expectRejectCode(removal, "path-mismatch");
        expect(attempts).toBe(1);
        expect(await fs.readFile(target, "utf8")).toBe("successor");
        expect(await fs.lstat(retained, { bigint: true })).toMatchObject({
          dev: identity.dev,
          ino: identity.ino,
        });
        expect(await fs.readFile(retained, "utf8")).toBe("original");
      }
    },
  );

  it.each(["file", "directory"] as const)(
    "rejects a replacement %s immediately after the original removal reports EIO",
    async (kind) => {
      const root = await fs.realpath(await tempDirs.make("openclaw-fs-safe-retirement-"));
      const target = path.join(root, "target");
      const retained = path.join(root, "retained");
      if (kind === "directory") {
        await fs.mkdir(target);
      } else {
        await fs.writeFile(target, "original");
      }
      const identity = await fs.lstat(target, { bigint: true });
      let injections = 0;
      const replace = async () => {
        injections += 1;
        await fs.rename(target, retained);
        if (kind === "directory") {
          await fs.mkdir(target);
          await fs.writeFile(path.join(target, "sentinel.txt"), "successor");
        } else {
          await fs.writeFile(target, "successor");
        }
        throw Object.assign(new Error("removal failed after replacement"), { code: "EIO" });
      };
      const unlink = fs.unlink.bind(fs);
      const rmdir = fs.rmdir.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
        if (kind === "file" && String(args[0]) === target) {
          await replace();
        }
        await unlink(...args);
      });
      vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
        if (kind === "directory" && String(args[0]) === target) {
          await replace();
        }
        await rmdir(...args);
      });

      await expectRejectCode(
        removePathWithinRoot({ rootDir: root, relativePath: "target", recursive: true }),
        "path-mismatch",
      );

      expect(injections).toBe(1);
      expect(await fs.lstat(retained, { bigint: true })).toMatchObject({
        dev: identity.dev,
        ino: identity.ino,
      });
      expect(
        await fs.readFile(
          kind === "directory" ? path.join(target, "sentinel.txt") : target,
          "utf8",
        ),
      ).toBe("successor");
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves a file held without delete sharing until its native handle closes",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-held-");
      const target = path.join(root, "held.txt");
      const sentinel = path.join(root, "sentinel.txt");
      await fs.writeFile(target, "held contents");
      await fs.writeFile(sentinel, "retained");
      const identity = await fs.lstat(target, { bigint: true });
      const sentinelIdentity = await fs.lstat(sentinel, { bigint: true });
      const { createFile, closeHandle } = loadWindowsFileApi();
      // FILE_SHARE_READ | FILE_SHARE_WRITE intentionally omits FILE_SHARE_DELETE.
      // libuv's DELETE open must fail until this non-inheritable handle closes.
      const handle = BigInt(
        createFile(path.toNamespacedPath(target), 0x80000000, 3, null, 3, 0, null),
      );
      try {
        expect(handle).not.toBe(-1n);
        expect(identity.isFile()).toBe(true);
        expect(identity.dev).not.toBe(0n);
        expect(identity.ino).not.toBe(0n);
        await expect(
          removePathWithinRoot({
            rootDir: root,
            relativePath: "held.txt",
            force: false,
          }),
        ).rejects.toMatchObject({ code: "not-removable", cause: { code: "EBUSY" } });
        expect(await fs.lstat(target, { bigint: true })).toMatchObject({
          dev: identity.dev,
          ino: identity.ino,
        });
        expect(await fs.readFile(target, "utf8")).toBe("held contents");
      } finally {
        if (handle !== -1n) {
          expect(closeHandle(handle)).not.toBe(0);
        }
      }

      await removePathWithinRoot({ rootDir: root, relativePath: "held.txt", force: false });
      await expectRejectCode(fs.lstat(target), "ENOENT");
      expect(await fs.lstat(sentinel, { bigint: true })).toMatchObject({
        dev: sentinelIdentity.dev,
        ino: sentinelIdentity.ino,
      });
      expect(await fs.readFile(sentinel, "utf8")).toBe("retained");
    },
  );

  it.runIf(process.platform === "win32")(
    "removes a tree containing a file with the native read-only attribute",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-readonly-");
      const tree = path.join(root, "tree");
      const target = path.join(tree, "readonly.txt");
      const sentinel = path.join(root, "sentinel.txt");
      await fs.mkdir(tree);
      await fs.writeFile(target, "read-only contents");
      await fs.writeFile(sentinel, "retained");
      const identity = await fs.lstat(target, { bigint: true });
      const sentinelIdentity = await fs.lstat(sentinel, { bigint: true });
      const { getFileAttributes, setFileAttributes } = loadWindowsFileApi();
      const nativePath = path.toNamespacedPath(target);
      const originalAttributes = getFileAttributes(nativePath);
      expect(originalAttributes).not.toBe(0xffffffff);
      expect(identity.isFile()).toBe(true);
      expect(identity.dev).not.toBe(0n);
      expect(identity.ino).not.toBe(0n);
      try {
        // FILE_ATTRIBUTE_NORMAL is valid alone; retain other attributes when adding READONLY.
        expect(setFileAttributes(nativePath, (originalAttributes & ~0x80) | 0x1)).not.toBe(0);
        const attributes = getFileAttributes(nativePath);
        expect(attributes).not.toBe(0xffffffff);
        expect(attributes & 0x1).toBe(0x1);
        expect(await fs.lstat(target, { bigint: true })).toMatchObject({
          dev: identity.dev,
          ino: identity.ino,
        });
        expect(await fs.readFile(target, "utf8")).toBe("read-only contents");

        // Current libuv may clear the attribute itself; exercise real cleanup without forcing EPERM.
        await removePathWithinRoot({
          rootDir: root,
          relativePath: "tree",
          recursive: true,
          force: false,
        });
        await expectRejectCode(fs.lstat(tree), "ENOENT");
        expect(await fs.lstat(sentinel, { bigint: true })).toMatchObject({
          dev: sentinelIdentity.dev,
          ino: sentinelIdentity.ino,
        });
        expect(await fs.readFile(sentinel, "utf8")).toBe("retained");
      } finally {
        const remaining = await fs.lstat(target, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        });
        if (remaining) {
          // Restore only this unchanged fixture before the shared temp-directory cleanup.
          expect(remaining.isFile()).toBe(true);
          expect(remaining).toMatchObject({ dev: identity.dev, ino: identity.ino });
          expect(await fs.readFile(target, "utf8")).toBe("read-only contents");
          expect(setFileAttributes(nativePath, originalAttributes)).not.toBe(0);
          expect(getFileAttributes(nativePath)).toBe(originalAttributes);
        }
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "does not delete through a rebound junction during recursive removal",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const nestedDir = path.join(root, "tree", "nested");
      const leafPath = path.join(nestedDir, "leaf.txt");
      const outside = await tempDirs.make("openclaw-fs-safe-outside-");
      const outsideFile = path.join(outside, "leaf.txt");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(leafPath, "leaf");
      await fs.writeFile(outsideFile, "outside");
      let rebound = false;
      const leafName = path.basename(leafPath).toLowerCase();
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, targetPath) => {
          if (
            rebound ||
            operation !== "remove" ||
            path.basename(targetPath).toLowerCase() !== leafName
          ) {
            return;
          }
          rebound = true;
          await createRebindableDirectoryAlias({
            aliasPath: nestedDir,
            targetPath: outside,
          });
        },
      });

      const removalError = await removePathWithinRoot({
        rootDir: root,
        relativePath: "tree",
        recursive: true,
        force: true,
      }).catch((error: unknown) => error);

      // The guarded remove may abort on the rebind or safely unlink only the raced junction.
      if (removalError === undefined) {
        await expectRejectCode(fs.stat(path.join(root, "tree")), "ENOENT");
      } else {
        expect((removalError as NodeJS.ErrnoException).code).toMatch(
          /path-mismatch|path-alias|outside-workspace|invalid-path|not-found|not-file|ENOENT|EPERM/,
        );
      }

      expect(rebound).toBe(true);
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    },
  );
});
