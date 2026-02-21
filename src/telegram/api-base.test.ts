import { mkdtemp, realpath, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getTelegramApiBase,
  isCustomTelegramApi,
  isLocalBotApiFilePath,
  validateLocalFilePath,
} from "./api-base.js";

describe("getTelegramApiBase", () => {
  it("returns default when no override", () => {
    expect(getTelegramApiBase()).toBe("https://api.telegram.org");
  });

  it("returns default for undefined override", () => {
    expect(getTelegramApiBase(undefined)).toBe("https://api.telegram.org");
  });

  it("returns default for empty-string override", () => {
    expect(getTelegramApiBase("")).toBe("https://api.telegram.org");
  });

  it("returns default for whitespace-only override", () => {
    expect(getTelegramApiBase("   ")).toBe("https://api.telegram.org");
  });

  it("uses explicit override", () => {
    expect(getTelegramApiBase("http://localhost:8081")).toBe("http://localhost:8081");
  });

  it("strips trailing slashes from override", () => {
    expect(getTelegramApiBase("http://localhost:8081///")).toBe("http://localhost:8081");
  });

  it("trims whitespace from override", () => {
    expect(getTelegramApiBase("  http://localhost:8081  ")).toBe("http://localhost:8081");
  });
});

describe("isCustomTelegramApi", () => {
  it("returns false for default API base", () => {
    expect(isCustomTelegramApi("https://api.telegram.org")).toBe(false);
  });

  it("returns false for default with trailing slash", () => {
    expect(isCustomTelegramApi("https://api.telegram.org/")).toBe(false);
  });

  it("returns true for localhost", () => {
    expect(isCustomTelegramApi("http://localhost:8081")).toBe(true);
  });

  it("returns true for custom domain", () => {
    expect(isCustomTelegramApi("https://tg-api.example.com")).toBe(true);
  });
});

describe("isLocalBotApiFilePath", () => {
  it("returns true for absolute path", () => {
    expect(isLocalBotApiFilePath("/tmp/telegram-bot-api/file_0.oga")).toBe(true);
  });

  it("returns false for relative path", () => {
    expect(isLocalBotApiFilePath("voice/file_0.oga")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLocalBotApiFilePath("")).toBe(false);
  });

  it("returns true for Windows absolute path", () => {
    expect(isLocalBotApiFilePath("C:\\telegram-bot-api\\file.oga")).toBe(true);
  });
});

describe("validateLocalFilePath", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(nodePath.join(tmpdir(), "tg-api-test-"));
    await mkdir(nodePath.join(baseDir, "subdir"), { recursive: true });
  });

  it("accepts a file inside the allowed directory", async () => {
    const filePath = nodePath.join(baseDir, "subdir", "voice.oga");
    await writeFile(filePath, "audio-data");

    const result = await validateLocalFilePath(filePath, baseDir);
    // realpath resolves symlinks and Windows 8.3 short names (e.g. RUNNER~1)
    expect(result).toBe(await realpath(filePath));
  });

  it("rejects a path that escapes the allowed directory via ..", async () => {
    // Create a real file outside the allowed dir so realpath resolves.
    const outsideFile = nodePath.join(tmpdir(), "secret.txt");
    await writeFile(outsideFile, "secret");

    const traversal = nodePath.join(baseDir, "subdir", "..", "..", nodePath.basename(outsideFile));

    await expect(validateLocalFilePath(traversal, baseDir)).rejects.toThrow(
      "escapes allowed directory",
    );
  });

  it("rejects a symlink that points outside the allowed directory", async () => {
    const outsideFile = nodePath.join(tmpdir(), "secret-target.txt");
    await writeFile(outsideFile, "secret");

    const link = nodePath.join(baseDir, "sneaky-link.txt");
    await symlink(outsideFile, link);

    await expect(validateLocalFilePath(link, baseDir)).rejects.toThrow("escapes allowed directory");
  });

  it("rejects a path to a non-existent file (realpath fails)", async () => {
    const missing = nodePath.join(baseDir, "does-not-exist.oga");
    await expect(validateLocalFilePath(missing, baseDir)).rejects.toThrow();
  });

  it("throws when localApiDataDir resolves to filesystem root", async () => {
    const filePath = nodePath.join(baseDir, "subdir", "voice.oga");
    await writeFile(filePath, "audio-data");

    await expect(validateLocalFilePath(filePath, "/")).rejects.toThrow(
      "localApiDataDir must not resolve to the filesystem root",
    );
  });

  it("throws when localApiDataDir is not configured", async () => {
    const filePath = nodePath.join(baseDir, "subdir", "voice.oga");
    await writeFile(filePath, "audio-data");

    await expect(validateLocalFilePath(filePath)).rejects.toThrow(
      "localApiDataDir must be configured",
    );
    await expect(validateLocalFilePath(filePath, "")).rejects.toThrow(
      "localApiDataDir must be configured",
    );
    await expect(validateLocalFilePath(filePath, "   ")).rejects.toThrow(
      "localApiDataDir must be configured",
    );
  });
});
