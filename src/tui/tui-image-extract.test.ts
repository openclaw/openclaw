import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractImagePaths, loadImageAttachments } from "./tui-image-extract.js";

describe("extractImagePaths", () => {
  it("should extract absolute path", () => {
    const result = extractImagePaths("look at this @/home/user/photo.png please");
    expect(result.paths).toEqual(["/home/user/photo.png"]);
    expect(result.cleanText).toBe("look at this please");
  });

  it("should extract relative path with ./", () => {
    const result = extractImagePaths("check @./images/test.jpg");
    expect(result.paths).toEqual(["./images/test.jpg"]);
    expect(result.cleanText).toBe("check");
  });

  it("should extract home-relative path with ~/", () => {
    const result = extractImagePaths("see @~/Pictures/screenshot.webp");
    expect(result.paths).toEqual(["~/Pictures/screenshot.webp"]);
    expect(result.cleanText).toBe("see");
  });

  it("should extract quoted path with spaces", () => {
    const result = extractImagePaths('here @"/path/with spaces/image.png" ok');
    expect(result.paths).toEqual(["/path/with spaces/image.png"]);
    expect(result.cleanText).toBe("here ok");
  });

  it("should extract single-quoted path with spaces", () => {
    const result = extractImagePaths("here @'./path/with spaces/image.jpeg' ok");
    expect(result.paths).toEqual(["./path/with spaces/image.jpeg"]);
    expect(result.cleanText).toBe("here ok");
  });

  it("should extract multiple image paths", () => {
    const result = extractImagePaths("compare @/a/one.png and @./two.jpg");
    expect(result.paths).toEqual(["/a/one.png", "./two.jpg"]);
    expect(result.cleanText).toBe("compare and");
  });

  it("should ignore non-image extensions", () => {
    const result = extractImagePaths("look @/home/file.txt and @./doc.pdf");
    expect(result.paths).toEqual([]);
    expect(result.cleanText).toBe("look @/home/file.txt and @./doc.pdf");
  });

  it("should handle text with no image references", () => {
    const result = extractImagePaths("just plain text");
    expect(result.paths).toEqual([]);
    expect(result.cleanText).toBe("just plain text");
  });

  it("should handle all supported image extensions", () => {
    const exts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
    for (const ext of exts) {
      const result = extractImagePaths(`@/test/img.${ext}`);
      expect(result.paths).toEqual([`/test/img.${ext}`]);
    }
  });

  it("should be case insensitive for extensions", () => {
    const result = extractImagePaths("@/test/img.PNG @./test/img.JpEg");
    expect(result.paths).toEqual(["/test/img.PNG", "./test/img.JpEg"]);
  });

  it("should return empty cleanText when entire message is an image ref", () => {
    const result = extractImagePaths("@/home/user/photo.png");
    expect(result.paths).toEqual(["/home/user/photo.png"]);
    expect(result.cleanText).toBe("");
  });
});

describe("loadImageAttachments", () => {
  const tmpDir = path.join(process.cwd(), ".test-tmp-images");

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should load a valid image file and return base64 content", async () => {
    // Write a minimal PNG (1x1 pixel)
    const pngHeader = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
        "0000000a49444154789c626000000002000198e195280000000049454e44ae426082",
      "hex",
    );
    const filePath = path.join(tmpDir, "test.png");
    await fs.writeFile(filePath, pngHeader);

    const result = await loadImageAttachments([filePath]);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("test.png");
    expect(result[0].mimeType).toBe("image/png");
    expect(result[0].content).toBe(pngHeader.toString("base64"));
  });

  it("should detect correct MIME types for different extensions", async () => {
    const cases: Array<[string, string]> = [
      ["test.jpg", "image/jpeg"],
      ["test.jpeg", "image/jpeg"],
      ["test.gif", "image/gif"],
      ["test.webp", "image/webp"],
      ["test.bmp", "image/bmp"],
      ["test.svg", "image/svg+xml"],
    ];

    for (const [name, expectedMime] of cases) {
      const filePath = path.join(tmpDir, name);
      await fs.writeFile(filePath, Buffer.from("fake image data"));
      const result = await loadImageAttachments([filePath]);
      expect(result[0].mimeType).toBe(expectedMime);
    }
  });

  it("should throw on file not found", async () => {
    await expect(loadImageAttachments(["/nonexistent/path/image.png"])).rejects.toThrow(
      "file not found",
    );
  });

  it("should throw on unsupported extension", async () => {
    const filePath = path.join(tmpDir, "doc.txt");
    await fs.writeFile(filePath, "not an image");
    await expect(loadImageAttachments([filePath])).rejects.toThrow("not a supported image file");
  });

  it("should throw on file too large", async () => {
    const filePath = path.join(tmpDir, "huge.png");
    // Write slightly over 5 MB
    const buf = Buffer.alloc(5_000_001, 0);
    await fs.writeFile(filePath, buf);
    await expect(loadImageAttachments([filePath])).rejects.toThrow("file too large");
  });

  it("should resolve ~/ paths using HOME env", async () => {
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tmpDir;
      const filePath = path.join(tmpDir, "home-img.png");
      await fs.writeFile(filePath, Buffer.from("fake"));
      const result = await loadImageAttachments(["~/home-img.png"]);
      expect(result[0].fileName).toBe("home-img.png");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("should load multiple files", async () => {
    const file1 = path.join(tmpDir, "a.png");
    const file2 = path.join(tmpDir, "b.jpg");
    await fs.writeFile(file1, Buffer.from("img1"));
    await fs.writeFile(file2, Buffer.from("img2"));

    const result = await loadImageAttachments([file1, file2]);
    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe("a.png");
    expect(result[1].fileName).toBe("b.jpg");
  });
});
