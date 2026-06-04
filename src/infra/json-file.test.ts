// Covers JSON file load/save behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

const canCreateFileSymlinks = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-json-symlink-probe-"));
  const targetFile = path.join(probeDir, "target.json");
  const linkFile = path.join(probeDir, "link.json");
  try {
    fs.writeFileSync(targetFile, "{}", "utf8");
    fs.symlinkSync(targetFile, linkFile, "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

const SAVED_PAYLOAD = { enabled: true, count: 2 };
const PREVIOUS_JSON = '{"enabled":false}\n';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeExistingJson(pathname: string) {
  fs.writeFileSync(pathname, PREVIOUS_JSON, "utf8");
}

async function withJsonPath<T>(
  run: (params: { root: string; pathname: string }) => Promise<T> | T,
): Promise<T> {
  return withTempDir({ prefix: "openclaw-json-file-" }, async (root) =>
    run({ root, pathname: path.join(root, "config.json") }),
  );
}

async function withJsonSymlink<T>(
  run: (params: {
    root: string;
    targetDir: string;
    targetPath: string;
    linkPath: string;
  }) => Promise<T> | T,
): Promise<T> {
  return withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
    const targetDir = path.join(root, "target");
    return run({
      root,
      targetDir,
      targetPath: path.join(targetDir, "config.json"),
      linkPath: path.join(root, "config-link.json"),
    });
  });
}

function expectSavedPayloadThroughSymlink(linkPath: string, targetPath: string) {
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(loadJsonFile(targetPath)).toEqual(SAVED_PAYLOAD);
  expect(loadJsonFile(linkPath)).toEqual(SAVED_PAYLOAD);
}

describe("json-file helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "missing files",
      setup: () => {},
    },
    {
      name: "invalid JSON files",
      setup: (pathname: string) => {
        fs.writeFileSync(pathname, "{", "utf8");
      },
    },
    {
      name: "directory targets",
      setup: (pathname: string) => {
        fs.mkdirSync(pathname);
      },
    },
  ])("returns undefined for $name", async ({ setup }) => {
    await withJsonPath(({ pathname }) => {
      setup(pathname);
      expect(loadJsonFile(pathname)).toBeUndefined();
    });
  });

  it("creates parent dirs, writes a trailing newline, and loads the saved object", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "nested", "config.json");
      saveJsonFile(pathname, SAVED_PAYLOAD);

      const raw = fs.readFileSync(pathname, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);

      const fileMode = fs.statSync(pathname).mode & 0o777;
      const dirMode = fs.statSync(path.dirname(pathname)).mode & 0o777;
      if (process.platform === "win32") {
        expect(fileMode & 0o111).toBe(0);
      } else {
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
      }
    });
  });

  it.each([
    {
      name: "new files",
      setup: () => {},
    },
    {
      name: "existing JSON files",
      setup: writeExistingJson,
    },
  ])("writes the latest payload for $name", async ({ setup }) => {
    await withJsonPath(({ pathname }) => {
      setup(pathname);
      saveJsonFile(pathname, SAVED_PAYLOAD);
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);
    });
  });

  it("writes through a sibling temp file before replacing the destination", async () => {
    await withJsonPath(({ pathname }) => {
      writeExistingJson(pathname);
      const renameSpy = vi.spyOn(fs, "renameSync");

      saveJsonFile(pathname, SAVED_PAYLOAD);

      const renameCall = renameSpy.mock.calls.find(([, target]) => target === pathname);
      expect(renameCall?.[0]).toMatch(new RegExp(`^${escapeRegExp(pathname)}\\..+\\.tmp$`));
      expect(renameSpy).toHaveBeenCalledWith(renameCall?.[0], pathname);
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);
    });
  });

  it.skipIf(!canCreateFileSymlinks)(
    "preserves symlink destinations when replacing existing JSON files",
    async () => {
      await withJsonSymlink(({ targetDir, targetPath, linkPath }) => {
        fs.mkdirSync(targetDir, { recursive: true });
        writeExistingJson(targetPath);
        fs.symlinkSync(targetPath, linkPath);

        saveJsonFile(linkPath, SAVED_PAYLOAD);

        expectSavedPayloadThroughSymlink(linkPath, targetPath);
      });
    },
  );

  it.skipIf(!canCreateFileSymlinks)(
    "creates a missing target file through an existing symlink",
    async () => {
      await withJsonSymlink(({ targetDir, targetPath, linkPath }) => {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.symlinkSync(targetPath, linkPath);

        saveJsonFile(linkPath, SAVED_PAYLOAD);

        expectSavedPayloadThroughSymlink(linkPath, targetPath);
      });
    },
  );

  it.skipIf(!canCreateFileSymlinks)(
    "does not create missing target directories through an existing symlink",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const missingTargetDir = path.join(root, "missing-target");
        const targetPath = path.join(missingTargetDir, "config.json");
        const linkPath = path.join(root, "config-link.json");
        fs.symlinkSync(targetPath, linkPath);

        let saveError: unknown;
        try {
          saveJsonFile(linkPath, SAVED_PAYLOAD);
        } catch (error) {
          saveError = error;
        }
        if (saveError === undefined) {
          throw new Error("Expected saveJsonFile to fail");
        }
        expect((saveError as { code?: unknown }).code).toBe("ENOENT");
        expect(fs.existsSync(missingTargetDir)).toBe(false);
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      });
    },
  );

  it("preserves payload when rename-based overwrite reports EPERM", async () => {
    await withJsonPath(({ root, pathname }) => {
      writeExistingJson(pathname);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      saveJsonFile(pathname, SAVED_PAYLOAD);

      expect(renameSpy).toHaveBeenCalled();
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);
      expect(fs.readdirSync(root)).toEqual(["config.json"]);
    });
  });
});
