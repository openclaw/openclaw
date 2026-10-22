import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  tryReadSecretFileSync,
  writePrivateSecretFileAtomic,
} from "./secret-file.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-secret-file-test-");

afterEach(() => tempDirs.cleanup());

async function secret(content: string) {
  const file = path.join(await createTempDir(), "secret.txt");
  await fsPromises.writeFile(file, content, "utf8");
  return file;
}
const writeSecret = (rootDir: string, filePath = path.join(rootDir, "nested", "auth.json")) =>
  writePrivateSecretFileAtomic({ rootDir, filePath, content: '{"ok":true}\n' });
const diagnostic = { configPath: "channels.telegram.tokenFile" };
const read = (file: string, options?: Parameters<typeof readSecretFileSync>[2]) =>
  readSecretFileSync(file, "Gateway password", options);
const tryRead = (file?: string) =>
  tryReadSecretFileSync(file, "Telegram bot token", undefined, diagnostic);

async function symlink(target: string) {
  const link = path.join(await createTempDir(), "secret-link.txt");
  await fsPromises.symlink(target, link);
  return link;
}

describe("readSecretFileSync", () => {
  it("rejects blank file paths", () => {
    expect(() => read("   ")).toThrow("Gateway password file path is empty.");
  });

  it("reads and trims a regular secret file", async () => {
    const file = await secret(" top-secret \n");

    expect(read(file)).toBe("top-secret");
    expect(tryReadSecretFileSync(file, "Gateway password")).toBe("top-secret");
  });

  it("preserves the underlying cause when throwing for missing files", async () => {
    const file = path.join(await createTempDir(), "missing-secret.txt");
    let thrown: Error | undefined;
    try {
      read(file);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain(`Failed to inspect Gateway password file at ${file}:`);
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it.each([
    [
      "oversized",
      () => secret("x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1)),
      `exceeds ${DEFAULT_SECRET_FILE_MAX_BYTES} bytes.`,
    ],
    ["non-regular", createTempDir, "must be a regular file."],
    ["symlink", async () => symlink(await secret("top-secret\n")), "must not be a symlink."],
    ["empty", () => secret(" \n\t "), "is empty."],
  ] as const)("rejects %s secret files", async (kind, setup, message) => {
    const file = await setup();
    expect(() => read(file, kind === "symlink" ? { rejectSymlink: true } : undefined)).toThrow(
      `Gateway password file at ${file} ${message}`,
    );
  });

  it("throws from the try helper for rejected files", async () => {
    const target = await secret("top-secret\n");
    const file = await symlink(target);

    expect(() =>
      tryReadSecretFileSync(file, "Telegram bot token", { rejectSymlink: true }),
    ).toThrow(`Telegram bot token file at ${file} must not be a symlink.`);
  });

  it.each(["   ", undefined])("returns undefined for absent path %j", (file) => {
    expect(tryReadSecretFileSync(file, "Telegram bot token")).toBeUndefined();
  });
});

describe("tryReadSecretFileSync diagnostics", () => {
  it.each(["invalid-path", "not-found"] as const)(
    "redacts a configured %s file",
    async (reason) => {
      const file =
        reason === "invalid-path"
          ? await secret(" \n\t ")
          : path.join(await createTempDir(), "missing-token.txt");
      const result = tryRead(file);
      expect(result).toEqual({
        status: "configured_unavailable",
        diagnostic: {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.telegram.tokenFile",
          reason,
        },
      });
      expect(JSON.stringify(result)).not.toContain(file);
    },
  );

  it("distinguishes missing input from an unavailable configured file", () => {
    expect(tryRead()).toEqual({
      status: "missing",
    });
  });
});

describe("writePrivateSecretFileAtomic", () => {
  it("writes a private file with owner-only permissions", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "nested", "auth.json");

    await writeSecret(dir, file);

    expect(read(file)).toBe('{"ok":true}');
    if (process.platform !== "win32") {
      const dirStat = await fsPromises.stat(path.dirname(file));
      const fileStat = await fsPromises.stat(file);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
      expect(fileStat.mode & 0o777).toBe(PRIVATE_SECRET_FILE_MODE);
    }
  });

  it("tightens an existing world-readable directory before writing secrets", async () => {
    const dir = await createTempDir();
    const nestedDir = path.join(dir, "nested");
    await fsPromises.mkdir(nestedDir, { mode: 0o777 });
    if (process.platform !== "win32") {
      await writeSecret(dir);
      const dirStat = await fsPromises.stat(nestedDir);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
    }
  });

  it.each(["file", "parent", "root"] as const)("rejects a symlinked %s", async (kind) => {
    const dir = await createTempDir();
    const target = kind === "file" ? await secret("outside") : await createTempDir();
    const link = path.join(dir, kind === "file" ? "nested/auth.json" : kind);
    if (kind === "file") {
      await fsPromises.mkdir(path.dirname(link));
    }
    if (kind === "root" && process.platform !== "win32") {
      await fsPromises.chmod(target, 0o777);
    }
    await fsPromises.symlink(target, link);
    await expect(
      writeSecret(
        kind === "root" ? link : dir,
        kind === "file" ? link : path.join(link, "auth.json"),
      ),
    ).rejects.toThrow("must not be a symlink");
    if (kind === "root" && process.platform !== "win32") {
      expect((await fsPromises.stat(target)).mode & 0o777).toBe(0o777);
    }
  });
});
