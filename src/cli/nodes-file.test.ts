import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";

let parseFileReadPayload: typeof import("./nodes-file.js").parseFileReadPayload;
let fileTempPath: typeof import("./nodes-file.js").fileTempPath;
let writeFilePayloadToFile: typeof import("./nodes-file.js").writeFilePayloadToFile;

describe("nodes file helpers", () => {
  beforeAll(async () => {
    ({ parseFileReadPayload, fileTempPath, writeFilePayloadToFile } =
      await import("./nodes-file.js"));
  });

  it("parses valid file.read payload", () => {
    const payload = parseFileReadPayload({
      path: "/home/user/doc.txt",
      encoding: "base64",
      data: "aGVsbG8=",
      size: 5,
      mimeType: "text/plain",
    });
    expect(payload).toEqual({
      path: "/home/user/doc.txt",
      encoding: "base64",
      data: "aGVsbG8=",
      size: 5,
      mimeType: "text/plain",
    });
  });

  it("throws when data is missing", () => {
    expect(() =>
      parseFileReadPayload({
        path: "/tmp/x.bin",
        encoding: "base64",
        size: 10,
      }),
    ).toThrow(/missing data/i);
  });

  it("throws when path is missing", () => {
    expect(() =>
      parseFileReadPayload({
        encoding: "base64",
        data: "aGk=",
        size: 2,
      }),
    ).toThrow(/missing path/i);
  });

  it("extracts correct extension from remotePath", () => {
    const p = fileTempPath({
      remotePath: "/home/user/report.pdf",
      tmpDir: "/tmp",
      id: "test1",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-file-transfer-test1.pdf"));
  });

  it("falls back to .bin when remotePath has no extension", () => {
    const p = fileTempPath({
      remotePath: "/home/user/noext",
      tmpDir: "/tmp",
      id: "test2",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-file-transfer-test2.bin"));
  });

  it("writes base64 data correctly to file", async () => {
    await withTempDir("openclaw-test-", async (dir) => {
      const outPath = path.join(dir, "out.bin");
      const result = await writeFilePayloadToFile(outPath, {
        path: "/remote/file.bin",
        encoding: "base64",
        data: "aGVsbG8=", // "hello"
        size: 5,
      });
      expect(result.path).toBe(outPath);
      expect(result.size).toBe(5);
      const content = await fs.readFile(outPath, "utf8");
      expect(content).toBe("hello");
    });
  });

  it("writes utf8 data correctly to file", async () => {
    await withTempDir("openclaw-test-", async (dir) => {
      const outPath = path.join(dir, "out.txt");
      const result = await writeFilePayloadToFile(outPath, {
        path: "/remote/file.txt",
        encoding: "utf8",
        data: "hello world",
        size: 11,
      });
      expect(result.path).toBe(outPath);
      expect(result.size).toBe(11);
      const content = await fs.readFile(outPath, "utf8");
      expect(content).toBe("hello world");
    });
  });
});
