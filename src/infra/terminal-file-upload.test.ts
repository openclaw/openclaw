import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../packages/gateway-protocol/src/terminal-upload-constants.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  recoverTerminalUploadCleanup,
  sanitizeTerminalUploadName,
  stageTerminalUpload,
} from "./terminal-file-upload.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("terminal file upload", () => {
  it("stages arbitrary bytes under a private temporary directory", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-test-");
    const content = Buffer.from([0, 1, 2, 255]);

    const result = await stageTerminalUpload(
      { name: "../report final.pdf", contentBase64: content.toString("base64") },
      { tempRoot: root, cleanupAfterMs: 60_000 },
    );

    expect(path.basename(result.path)).toBe("report final.pdf");
    expect(result.path.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(result.size).toBe(content.length);
    expect(await readFile(result.path)).toEqual(content);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(result.path))).mode & 0o777).toBe(0o700);
  });

  it("normalizes hostile and oversized names", () => {
    expect(sanitizeTerminalUploadName("..\\..\\secret\u0000.txt")).toBe("secret_.txt");
    expect(sanitizeTerminalUploadName("report:<final>?!-%PATH%.pdf. ")).toBe(
      "report__final___-_PATH_.pdf",
    );
    expect(sanitizeTerminalUploadName("CON.txt")).toBe("_CON.txt");
    expect(
      Buffer.byteLength(sanitizeTerminalUploadName("🦞".repeat(100)), "utf8"),
    ).toBeLessThanOrEqual(180);
    expect(sanitizeTerminalUploadName("..")).toBe("upload");
  });

  it("recovers expired upload directories after restart", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-recovery-test-");
    const directory = path.join(root, "openclaw-terminal-upload-stale");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "report.pdf"), "stale");
    await utimes(directory, new Date(0), new Date(0));

    await recoverTerminalUploadCleanup({ tempRoot: root, retentionMs: 1, nowMs: Date.now() });

    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed and oversized payloads", async () => {
    const root = tempDirs.make("openclaw-terminal-upload-test-");
    await expect(
      stageTerminalUpload({ name: "bad.bin", contentBase64: "not base64" }, { tempRoot: root }),
    ).rejects.toThrow("invalid terminal upload encoding");
    await expect(
      stageTerminalUpload(
        {
          name: "large.bin",
          contentBase64: Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1).toString("base64"),
        },
        { tempRoot: root },
      ),
    ).rejects.toThrow("exceeds");
  });
});
