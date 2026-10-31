import fs from "node:fs";
import path from "node:path";
import { loadSecretFileSync as coreSecret } from "openclaw/plugin-sdk/core";
import {
  fileExists,
  readFileWithinRoot,
  readLocalFileFromRoots,
  removePathWithinRoot,
  root as openRoot,
  writeFileWithinRoot,
} from "openclaw/plugin-sdk/file-access-runtime";
import type {
  TempWorkspace as SandboxTempWorkspace,
  tempWorkspace as sandboxTempWorkspace,
  withTempWorkspace as sandboxWithTempWorkspace,
} from "openclaw/plugin-sdk/sandbox";
import {
  loadSecretFileSync,
  type SecretFileReadResult,
} from "openclaw/plugin-sdk/secret-file-runtime";
import {
  fileExists as fileExistsFromSecurity,
  replaceFileAtomic,
} from "openclaw/plugin-sdk/security-runtime";
import {
  tempWorkspace,
  withTempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";

describe("plugin SDK fs-safe compatibility exports", () => {
  it("accepts the legacy atomic adapter chmod member without calling it", async () => {
    await withTestDir({ prefix: "openclaw-sdk-atomic-compat-" }, async (root) => {
      const filePath = path.join(root, "state.txt");
      const chmod = vi.fn(async () => {
        throw new Error("pathname chmod must remain unused");
      });
      await replaceFileAtomic({
        filePath,
        content: "saved",
        mode: 0o600,
        fileSystem: { promises: { ...fs.promises, chmod } },
      });
      expect(fs.readFileSync(filePath, "utf8")).toBe("saved");
      expect(chmod).not.toHaveBeenCalled();
    });
  });

  it.each([
    { subpath: "file-access-runtime", exists: fileExists },
    { subpath: "security-runtime", exists: fileExistsFromSecurity },
  ])("keeps $subpath file checks limited to regular files", async ({ exists }) => {
    await withTestDir({ prefix: "openclaw-sdk-file-exists-" }, async (root) => {
      const filePath = path.join(root, "file.txt");
      const symlinkPath = path.join(root, "linked.txt");
      fs.writeFileSync(filePath, "content");
      fs.symlinkSync(filePath, symlinkPath);

      for (const [candidate, expected] of [
        [filePath, true],
        [path.join(root, "missing.txt"), false],
        [root, false],
        [symlinkPath, false],
      ] as const) {
        expect(exists(candidate), candidate).toBe(expected);
      }
    });
  });

  it("keeps deprecated secret-file result helpers on public SDK subpaths", async () => {
    await withTestDir({ prefix: "openclaw-sdk-secret-compat-" }, async (root) => {
      const secretPath = path.join(root, "token.txt");
      fs.writeFileSync(secretPath, "secret\n", { mode: 0o600 });

      const result: SecretFileReadResult = loadSecretFileSync(secretPath, "token");
      expect(result).toMatchObject({ ok: true, secret: "secret", resolvedPath: secretPath });
      expect(coreSecret(secretPath, "token")).toMatchObject({ ok: true, secret: "secret" });
    });
  });

  it("keeps root-bounded file-access helpers on file-access-runtime", async () => {
    expectTypeOf(removePathWithinRoot).toEqualTypeOf<
      (params: {
        rootDir: string;
        relativePath: string;
        recursive?: boolean;
        force?: boolean;
      }) => Promise<void>
    >();

    await withTestDir({ prefix: "openclaw-sdk-file-access-compat-" }, async (root) => {
      const file = { rootDir: root, relativePath: "nested/file.txt" };
      const absolutePath = path.join(root, file.relativePath);
      await writeFileWithinRoot({ ...file, data: "hello", mkdir: true });

      for (const nonBlockingRead of [undefined, true, false]) {
        const result = await readFileWithinRoot({ ...file, nonBlockingRead });
        expect(result.buffer).toEqual(Buffer.from("hello"));
        expect(result.realPath).toBe(fs.realpathSync(absolutePath));
      }

      await removePathWithinRoot({ ...file, force: false });
      expect(fs.existsSync(absolutePath)).toBe(false);
    });
  });

  it("keeps legacy hints on local-root reads and transitive temp workspace stores", async () => {
    expectTypeOf<typeof sandboxTempWorkspace>().toEqualTypeOf<typeof tempWorkspace>();
    expectTypeOf<typeof sandboxWithTempWorkspace>().toEqualTypeOf<typeof withTempWorkspace>();
    expectTypeOf<SandboxTempWorkspace>().toEqualTypeOf<TempWorkspace>();
    expectTypeOf<
      "walk" extends keyof Awaited<ReturnType<typeof openRoot>> ? true : false
    >().toEqualTypeOf<false>();

    await withTestDir({ prefix: "openclaw-sdk-temp-read-compat-" }, async (rootDir) => {
      await using workspace = await tempWorkspace({ rootDir, prefix: "read-" });
      const content = '{"ok":true}';
      const store = workspace.store;
      await workspace.writeText("data.json", content);
      const filePath = workspace.path("data.json");
      for (const nonBlockingRead of [undefined, true, false]) {
        const hints = { nonBlockingRead };
        const local = await readLocalFileFromRoots({ filePath, roots: [workspace.dir], ...hints });
        expect(local?.buffer.toString()).toBe(content);
        const opened = await store.open("data.json", hints);
        await opened.handle.close();
        expect((await store.read("data.json", hints)).buffer.toString()).toBe(content);
        expect((await store.readBytes("data.json", hints)).toString()).toBe(content);
        expect(await store.readText("data.json", { ...hints, encoding: "utf8" })).toBe(content);
        expect(await store.readTextIfExists("missing.json", hints)).toBeNull();
        const parsed = await store.readJson<{ ok: boolean }>("data.json", hints);
        expectTypeOf(parsed).toEqualTypeOf<{ ok: boolean }>();
        expect(parsed).toEqual({ ok: true });
        const missing = await store.readJsonIfExists<{ ok: boolean }>("missing.json", hints);
        expectTypeOf(missing).toEqualTypeOf<{ ok: boolean } | null>();
        expect(missing).toBeNull();
        const nestedRoot = await store.root();
        expectTypeOf(nestedRoot.walk).toBeFunction();
        expect(await nestedRoot.readText("data.json", hints)).toBe(content);
      }
      await expect(
        withTempWorkspace({ rootDir, prefix: "callback-" }, async (borrowed) => {
          await borrowed.writeText("callback.txt", "callback");
          return borrowed.store.readText("callback.txt", { nonBlockingRead: false });
        }),
      ).resolves.toBe("callback");
    });
  });

  it("keeps legacy read hints compatible across the SDK Root surface", async () => {
    await withTestDir({ prefix: "openclaw-sdk-root-read-compat-" }, async (root) => {
      const filePath = path.join(root, "data.json");
      const content = '{"ok":true}\n';
      const bytes = Buffer.from(content);
      const blocking = { nonBlockingRead: false };
      const nonBlocking = { nonBlockingRead: true };
      fs.writeFileSync(filePath, content);
      const scoped = await openRoot(root, blocking);
      expect(scoped.defaults.nonBlockingRead).toBe(false);

      const opened = await scoped.open("data.json", nonBlocking);
      try {
        expect(await opened.handle.readFile({ encoding: "utf8" })).toBe(content);
      } finally {
        await opened.handle.close();
      }

      expect((await scoped.read("data.json", blocking)).buffer).toEqual(bytes);
      expect(await scoped.readBytes("data.json", nonBlocking)).toEqual(bytes);
      expect(await scoped.readText("data.json", { ...blocking, encoding: "utf8" })).toBe(content);
      expect((await scoped.readAbsolute(filePath, nonBlocking)).buffer).toEqual(bytes);
      expect(await scoped.reader(blocking)(filePath)).toEqual(bytes);
      const parsed = await scoped.readJson<{ ok: boolean }>("data.json", nonBlocking);
      expectTypeOf(parsed).toEqualTypeOf<{ ok: boolean }>();
      expect(parsed).toEqual({ ok: true });
      await expect(
        scoped.read("data.json", { nonBlockingRead: false, maxBytes: 1 }),
      ).rejects.toMatchObject({ code: "too-large" });
    });
  });
});
