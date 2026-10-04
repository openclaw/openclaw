/**
 * Tests fs-safe compatibility exports used by plugin SDK callers.
 */
import fs from "node:fs";
import path from "node:path";
import { loadSecretFileSync as loadSecretFileSyncFromCore } from "openclaw/plugin-sdk/core";
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
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected secret-file read to succeed");
      }
      expect(result.secret).toBe("secret");
      expect(result.resolvedPath).toBe(secretPath);

      const coreResult = loadSecretFileSyncFromCore(secretPath, "token");
      expect(coreResult.ok).toBe(true);
      if (!coreResult.ok) {
        throw new Error("expected core secret-file read to succeed");
      }
      expect(coreResult.secret).toBe("secret");
    });
  });

  it("keeps root-bounded file-access helpers on file-access-runtime", async () => {
    expectTypeOf(removePathWithinRoot).parameters.toEqualTypeOf<
      [
        params: {
          rootDir: string;
          relativePath: string;
          recursive?: boolean;
          force?: boolean;
          assertBeforeMutation?: () => void;
        },
      ]
    >();
    expectTypeOf<keyof Parameters<typeof removePathWithinRoot>[0]>().toEqualTypeOf<
      "rootDir" | "relativePath" | "recursive" | "force" | "assertBeforeMutation"
    >();
    expectTypeOf(removePathWithinRoot).returns.toEqualTypeOf<Promise<void>>();

    await withTestDir({ prefix: "openclaw-sdk-file-access-compat-" }, async (root) => {
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: "nested/file.txt",
        data: "hello",
        mkdir: true,
      });

      for (const nonBlockingRead of [undefined, true, false]) {
        const result = await readFileWithinRoot({
          rootDir: root,
          relativePath: "nested/file.txt",
          nonBlockingRead,
        });

        expect(result.buffer.toString("utf8")).toBe("hello");
        expect(result.realPath).toBe(fs.realpathSync(path.join(root, "nested", "file.txt")));
      }

      const refusal = new Error("retired file owner");
      await expect(
        removePathWithinRoot({
          rootDir: root,
          relativePath: "nested/file.txt",
          assertBeforeMutation: () => {
            throw refusal;
          },
        }),
      ).rejects.toBe(refusal);
      expect(fs.existsSync(path.join(root, "nested", "file.txt"))).toBe(true);
      await removePathWithinRoot({
        rootDir: root,
        relativePath: "nested/file.txt",
        force: false,
      });

      expect(fs.existsSync(path.join(root, "nested", "file.txt"))).toBe(false);
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
      await workspace.writeText("data.json", '{"ok":true}');
      const filePath = workspace.path("data.json");
      for (const nonBlockingRead of [undefined, true, false]) {
        expect(
          (
            await readLocalFileFromRoots({
              filePath,
              roots: [workspace.dir],
              nonBlockingRead,
            })
          )?.buffer.toString(),
        ).toBe('{"ok":true}');
        const opened = await workspace.store.open("data.json", { nonBlockingRead });
        await opened.handle.close();
        expect(
          (await workspace.store.read("data.json", { nonBlockingRead })).buffer.toString(),
        ).toBe('{"ok":true}');
        expect((await workspace.store.readBytes("data.json", { nonBlockingRead })).toString()).toBe(
          '{"ok":true}',
        );
        expect(
          await workspace.store.readText("data.json", { nonBlockingRead, encoding: "utf8" }),
        ).toBe('{"ok":true}');
        expect(
          await workspace.store.readTextIfExists("missing.json", { nonBlockingRead }),
        ).toBeNull();
        const parsed = await workspace.store.readJson<{ ok: boolean }>("data.json", {
          nonBlockingRead,
        });
        expectTypeOf(parsed).toEqualTypeOf<{ ok: boolean }>();
        expect(parsed).toEqual({ ok: true });
        const missing = await workspace.store.readJsonIfExists<{ ok: boolean }>("missing.json", {
          nonBlockingRead,
        });
        expectTypeOf(missing).toEqualTypeOf<{ ok: boolean } | null>();
        expect(missing).toBeNull();
        const nestedRoot = await workspace.store.root();
        expectTypeOf(nestedRoot.walk).toBeFunction();
        expect(await nestedRoot.readText("data.json", { nonBlockingRead })).toBe('{"ok":true}');
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
      fs.writeFileSync(filePath, content);
      const scoped = await openRoot(root, { nonBlockingRead: false });
      expect(scoped.defaults.nonBlockingRead).toBe(false);

      const opened = await scoped.open("data.json", { nonBlockingRead: true });
      try {
        expect(await opened.handle.readFile({ encoding: "utf8" })).toBe(content);
      } finally {
        await opened.handle.close();
      }

      expect((await scoped.read("data.json", { nonBlockingRead: false })).buffer).toEqual(
        Buffer.from(content),
      );
      expect(await scoped.readBytes("data.json", { nonBlockingRead: true })).toEqual(
        Buffer.from(content),
      );
      expect(await scoped.readText("data.json", { nonBlockingRead: false, encoding: "utf8" })).toBe(
        content,
      );
      expect((await scoped.readAbsolute(filePath, { nonBlockingRead: true })).buffer).toEqual(
        Buffer.from(content),
      );
      expect(await scoped.reader({ nonBlockingRead: false })(filePath)).toEqual(
        Buffer.from(content),
      );
      const parsed = await scoped.readJson<{ ok: boolean }>("data.json", { nonBlockingRead: true });
      expectTypeOf(parsed).toEqualTypeOf<{ ok: boolean }>();
      expect(parsed).toEqual({ ok: true });
      await expect(
        scoped.read("data.json", { nonBlockingRead: false, maxBytes: 1 }),
      ).rejects.toMatchObject({ code: "too-large" });
    });
  });
});
